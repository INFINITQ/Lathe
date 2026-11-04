//! Searching a folder with ripgrep's crates: a parallel, gitignore-aware walk whose matches
//! stream out in batches while it runs. Open files with unsaved changes are searched as they
//! are in the editor. Replacing keeps each file's encoding, BOM and line endings, and takes VS
//! Code's replacement syntax (`$1`, `$&`, `$$`, `\n`, `\u`, `\U…\E`…).

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkFinish, SinkMatch};
use ignore::overrides::{Override, OverrideBuilder};
use ignore::{WalkBuilder, WalkState};
use regex::{Captures, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::files::{self, FileError};

/// What to look for, and where.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub pattern: String,
    pub is_regex: bool,
    pub match_case: bool,
    pub whole_word: bool,
    /// VS Code-style globs: `src`, `*.ts`, `./docs/**`. Empty means every file.
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    /// Honour .gitignore, .ignore and the global Git excludes.
    pub use_ignore_files: bool,
    /// Stop after this many matches.
    pub max_results: usize,
}

impl Default for Query {
    fn default() -> Self {
        Query {
            pattern: String::new(),
            is_regex: false,
            match_case: false,
            whole_word: false,
            include: Vec::new(),
            exclude: Vec::new(),
            use_ignore_files: true,
            max_results: 20_000,
        }
    }
}

/// One match. Lines are 1-based; columns are 0-based UTF-16 offsets, as the editor counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    /// The line, trimmed to the part around the match.
    pub preview: String,
    pub preview_start: u32,
    pub preview_len: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub matches: Vec<Match>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEvent {
    Files {
        files: Vec<FileMatches>,
    },
    Done {
        files: usize,
        matches: usize,
        limit_hit: bool,
        elapsed_ms: u64,
        error: Option<String>,
        /// Files that couldn't be opened (and the first one's error).
        unreadable: usize,
        first_unreadable: Option<String>,
    },
}

pub trait SearchSink: Send + Sync {
    fn send(&self, event: SearchEvent);
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("{0}")]
    Pattern(String),
    #[error("{0}")]
    Glob(String),
    #[error(transparent)]
    File(#[from] FileError),
}

impl SearchError {
    pub fn kind(&self) -> &'static str {
        match self {
            SearchError::Pattern(_) => "pattern",
            SearchError::Glob(_) => "glob",
            SearchError::File(err) => err.kind(),
        }
    }
}

fn pattern_of(query: &Query) -> String {
    if query.is_regex {
        query.pattern.clone()
    } else {
        regex::escape(&query.pattern)
    }
}

fn multi_line(query: &Query) -> bool {
    if query.is_regex {
        query.pattern.contains("\\n") || query.pattern.contains('\n')
    } else {
        query.pattern.contains('\n')
    }
}

fn matcher(query: &Query) -> Result<RegexMatcher, SearchError> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .case_insensitive(!query.match_case)
        .word(query.whole_word)
        .multi_line(true)
        .crlf(true);
    if !multi_line(query) {
        builder.line_terminator(Some(b'\n'));
    }
    builder
        .build(&pattern_of(query))
        .map_err(|err| SearchError::Pattern(err.to_string()))
}

/// The same pattern as a `regex::Regex`, for replacing.
fn replace_regex(query: &Query) -> Result<Regex, SearchError> {
    let mut pattern = pattern_of(query);
    if query.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.match_case)
        .multi_line(true)
        .build()
        .map_err(|err| SearchError::Pattern(err.to_string()))
}

/// VS Code's include and exclude globs as ignore-crate overrides. A plain name (`src`) means
/// that file or folder anywhere; `./x` is anchored at the root; anything else is a gitignore
/// glob.
fn overrides(root: &Path, include: &[String], exclude: &[String]) -> Result<Override, SearchError> {
    let mut builder = OverrideBuilder::new(root);
    let mut add = |glob: &str, negate: bool| -> Result<(), SearchError> {
        let glob = glob.trim().replace('\\', "/");
        if glob.is_empty() {
            return Ok(());
        }
        let plain = !glob.contains(['*', '?', '[', '{']);
        let globs = if let Some(anchored) = glob.strip_prefix("./") {
            let anchored = anchored.trim_end_matches('/');
            vec![format!("/{anchored}"), format!("/{anchored}/**")]
        } else if plain {
            let name = glob.trim_end_matches('/');
            vec![format!("**/{name}"), format!("**/{name}/**")]
        } else {
            vec![glob.clone()]
        };
        for glob in globs {
            let line = if negate { format!("!{glob}") } else { glob };
            builder
                .add(&line)
                .map_err(|err| SearchError::Glob(err.to_string()))?;
        }
        Ok(())
    };
    for glob in include {
        add(glob, false)?;
    }
    for glob in exclude {
        add(glob, true)?;
    }
    builder
        .build()
        .map_err(|err| SearchError::Glob(err.to_string()))
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// Widest preview, in characters; longer lines show a window around the match.
const PREVIEW_CHARS: usize = 250;
const PREVIEW_BEFORE: usize = 40;

/// The preview for a match at `start..end` (bytes) of `line`.
fn preview(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let end = end.min(line.len()).max(start);
    let indent = line.len() - line.trim_start().len();
    let mut from = if start >= indent { indent } else { 0 };
    let mut prefix = "";
    if line[from..start].chars().count() > PREVIEW_BEFORE {
        from = line[..start]
            .char_indices()
            .rev()
            .nth(PREVIEW_BEFORE - 1)
            .map_or(0, |(i, _)| i);
        prefix = "…";
    }
    let to = line[from..]
        .char_indices()
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(i, _)| from + i)
        .max(end.min(line.len()));
    let text = format!("{prefix}{}", &line[from..to]);
    let lead = utf16_len(prefix) + utf16_len(&line[from..start]);
    (text, lead, utf16_len(&line[start..end]))
}

/// Matches inside `block`, a run of whole lines whose first line is `first_line`.
fn matches_in(
    matcher: &RegexMatcher,
    block: &str,
    first_line: u32,
    mut keep: impl FnMut(Match) -> bool,
) -> io::Result<()> {
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(block.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let locate = |offset: usize| -> (u32, usize) {
        let index = line_starts
            .partition_point(|&s| s <= offset)
            .saturating_sub(1);
        (index as u32, line_starts[index])
    };
    let line_end = |start: usize| -> usize {
        let end = block[start..].find('\n').map_or(block.len(), |i| start + i);
        if end > start && block.as_bytes()[end - 1] == b'\r' {
            end - 1
        } else {
            end
        }
    };
    matcher
        .find_iter(block.as_bytes(), |m| {
            let (index, start_of_line) = locate(m.start());
            let line_text = &block[start_of_line..line_end(start_of_line)];
            let start = m.start() - start_of_line;
            if start > line_text.len() {
                return true;
            }
            let (end_index, end_line_start) = locate(m.end().max(m.start()));
            let end_line_text = &block[end_line_start..line_end(end_line_start)];
            let end = (m.end() - end_line_start).min(end_line_text.len());
            let same_line = end_index == index;
            let (text, preview_start, preview_len) = preview(
                line_text,
                start,
                if same_line { end } else { line_text.len() },
            );
            keep(Match {
                line: first_line + index,
                column: utf16_len(&line_text[..start]),
                end_line: first_line + end_index,
                end_column: utf16_len(&end_line_text[..end]),
                preview: text,
                preview_start,
                preview_len,
            })
        })
        .map_err(|err| io::Error::other(err.to_string()))
}

/// Collects one file's matches, and notices binary files so they can be dropped.
struct Collect<'a> {
    matcher: &'a RegexMatcher,
    matches: Vec<Match>,
    room: usize,
    cancel: &'a AtomicBool,
    binary: bool,
}

impl Sink for Collect<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let block = String::from_utf8_lossy(found.bytes());
        let first = found.line_number().unwrap_or(1) as u32;
        let mut more = true;
        matches_in(self.matcher, &block, first, |m| {
            self.matches.push(m);
            more = self.matches.len() < self.room;
            more
        })?;
        Ok(more)
    }

    fn finish(&mut self, _: &Searcher, finish: &SinkFinish) -> Result<(), io::Error> {
        self.binary = finish.binary_byte_offset().is_some();
        Ok(())
    }
}

/// Sends results in batches: the first right away, then at most every 40 ms.
struct Batcher {
    sink: Arc<dyn SearchSink>,
    pending: Mutex<(Vec<FileMatches>, Option<Instant>)>,
}

impl Batcher {
    fn push(&self, file: FileMatches) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.0.push(file);
        let due = pending
            .1
            .is_none_or(|last| last.elapsed() >= Duration::from_millis(40));
        if due || pending.0.len() >= 200 {
            let files = std::mem::take(&mut pending.0);
            pending.1 = Some(Instant::now());
            self.sink.send(SearchEvent::Files { files });
        }
    }

    fn flush(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if !pending.0.is_empty() {
            let files = std::mem::take(&mut pending.0);
            self.sink.send(SearchEvent::Files { files });
        }
    }
}

/// A path's key for matching open documents to files: Windows paths ignore case.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// Searches `root`, sending matches to `sink` as they're found and `Done` at the end.
/// `unsaved` holds the text of open files with unsaved changes, which is searched instead of
/// the file on disk. Setting `cancel` stops it early.
pub fn search(
    root: &Path,
    query: &Query,
    unsaved: &HashMap<PathBuf, String>,
    sink: Arc<dyn SearchSink>,
    cancel: Arc<AtomicBool>,
) {
    let started = Instant::now();
    let total = AtomicUsize::new(0);
    let file_count = AtomicUsize::new(0);
    let unreadable = AtomicUsize::new(0);
    let first_unreadable = Mutex::new(None::<String>);
    let limit_hit = AtomicBool::new(false);
    let batcher = Batcher {
        sink: sink.clone(),
        pending: Mutex::new((Vec::new(), None)),
    };
    let result = (|| -> Result<(), SearchError> {
        if query.pattern.is_empty() {
            return Ok(());
        }
        let matcher = matcher(query)?;
        let unsaved: HashMap<String, &String> =
            unsaved.iter().map(|(p, t)| (path_key(p), t)).collect();
        let mut walk = WalkBuilder::new(root);
        let ignore_files = query.use_ignore_files;
        walk.hidden(false)
            .git_ignore(ignore_files)
            .git_global(ignore_files)
            .git_exclude(ignore_files)
            .ignore(ignore_files)
            .parents(ignore_files)
            .require_git(false)
            .follow_links(false)
            .overrides(overrides(root, &query.include, &query.exclude)?)
            .threads(
                std::thread::available_parallelism()
                    .map(|n| n.get().min(8))
                    .unwrap_or(4),
            )
            .filter_entry(|entry| {
                !matches!(entry.file_name().to_str(), Some(".git" | ".hg" | ".svn"))
            });
        let limit = query.max_results.max(1);
        let multi = multi_line(query);
        walk.build_parallel().run(|| {
            let matcher = matcher.clone();
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .multi_line(multi)
                .build();
            let (total, file_count, limit_hit) = (&total, &file_count, &limit_hit);
            let (batcher, cancel, unsaved) = (&batcher, &cancel, &unsaved);
            let (unreadable, first_unreadable) = (&unreadable, &first_unreadable);
            Box::new(move |entry| {
                if cancel.load(Ordering::Relaxed) || limit_hit.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        // A folder that couldn't be listed: its files are missing from the results.
                        unreadable.fetch_add(1, Ordering::Relaxed);
                        let mut first = first_unreadable.lock().unwrap_or_else(|e| e.into_inner());
                        first.get_or_insert_with(|| err.to_string());
                        return WalkState::Continue;
                    }
                };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                let room = limit.saturating_sub(total.load(Ordering::Relaxed));
                if room == 0 {
                    limit_hit.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                let mut collect = Collect {
                    matcher: &matcher,
                    matches: Vec::new(),
                    room,
                    cancel,
                    binary: false,
                };
                let path = entry.path();
                let searched = match unsaved.get(&path_key(path)) {
                    Some(text) => searcher.search_slice(&matcher, text.as_bytes(), &mut collect),
                    None => {
                        // Antivirus or an indexer can hold a new file for a moment.
                        let mut attempt = 0;
                        loop {
                            collect.matches.clear();
                            let result = searcher.search_path(&matcher, path, &mut collect);
                            match &result {
                                Err(err) if attempt < 3 && transient(err) => {
                                    attempt += 1;
                                    std::thread::sleep(Duration::from_millis(40 * attempt));
                                }
                                _ => break result,
                            }
                        }
                    }
                };
                if let Err(err) = searched {
                    unreadable.fetch_add(1, Ordering::Relaxed);
                    let mut first = first_unreadable.lock().unwrap_or_else(|e| e.into_inner());
                    first.get_or_insert_with(|| format!("{}: {err}", path.display()));
                    return WalkState::Continue;
                }
                if collect.binary || collect.matches.is_empty() {
                    return WalkState::Continue;
                }
                let found = collect.matches.len();
                if total.fetch_add(found, Ordering::Relaxed) + found >= limit {
                    limit_hit.store(true, Ordering::Relaxed);
                }
                file_count.fetch_add(1, Ordering::Relaxed);
                batcher.push(FileMatches {
                    path: path.to_string_lossy().into_owned(),
                    matches: collect.matches,
                });
                WalkState::Continue
            })
        });
        Ok(())
    })();
    batcher.flush();
    sink.send(SearchEvent::Done {
        files: file_count.load(Ordering::Relaxed),
        matches: total.load(Ordering::Relaxed),
        limit_hit: limit_hit.load(Ordering::Relaxed),
        elapsed_ms: started.elapsed().as_millis() as u64,
        error: result.err().map(|err| err.to_string()),
        unreadable: unreadable.load(Ordering::Relaxed),
        first_unreadable: first_unreadable
            .into_inner()
            .unwrap_or_else(|e| e.into_inner()),
    });
}

/// Sharing and lock violations, and access denied: what a file held open by antivirus or an
/// indexer looks like for a moment.
fn transient(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

/// A parsed replacement: literal text, capture groups and VS Code's case changes.
#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Group(usize),
    Named(String),
    /// \u, \l: the next character; \U, \L: until \E.
    Case(CaseChange),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum CaseChange {
    UpperNext,
    LowerNext,
    Upper,
    Lower,
    End,
}

#[derive(Debug, Clone)]
pub struct Template {
    parts: Vec<Part>,
}

impl Template {
    /// In regex mode `$1`, `$<name>`, `$&`, `$$`, `\n`, `\t`, `\\` and the case changes mean
    /// something; otherwise the replacement is taken as it is.
    pub fn parse(replacement: &str, regex: bool) -> Template {
        if !regex {
            return Template {
                parts: vec![Part::Text(replacement.to_owned())],
            };
        }
        let mut parts = Vec::new();
        let mut text = String::new();
        let chars: Vec<char> = replacement.chars().collect();
        let mut i = 0;
        let flush = |text: &mut String, parts: &mut Vec<Part>| {
            if !text.is_empty() {
                parts.push(Part::Text(std::mem::take(text)));
            }
        };
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            match (c, next) {
                ('$', Some('$')) => {
                    text.push('$');
                    i += 2;
                }
                ('$', Some('&')) => {
                    flush(&mut text, &mut parts);
                    parts.push(Part::Group(0));
                    i += 2;
                }
                ('$', Some(d)) if d.is_ascii_digit() => {
                    let mut j = i + 1;
                    let mut n = 0usize;
                    while j < chars.len() && chars[j].is_ascii_digit() && j < i + 3 {
                        n = n * 10 + chars[j].to_digit(10).unwrap_or(0) as usize;
                        j += 1;
                    }
                    flush(&mut text, &mut parts);
                    parts.push(Part::Group(n));
                    i = j;
                }
                ('$', Some('<')) => match chars[i + 2..].iter().position(|&ch| ch == '>') {
                    Some(len) => {
                        flush(&mut text, &mut parts);
                        parts.push(Part::Named(chars[i + 2..i + 2 + len].iter().collect()));
                        i += 3 + len;
                    }
                    None => {
                        text.push('$');
                        i += 1;
                    }
                },
                ('\\', Some(e)) => {
                    let change = match e {
                        'u' => Some(CaseChange::UpperNext),
                        'l' => Some(CaseChange::LowerNext),
                        'U' => Some(CaseChange::Upper),
                        'L' => Some(CaseChange::Lower),
                        'E' => Some(CaseChange::End),
                        _ => None,
                    };
                    if let Some(change) = change {
                        flush(&mut text, &mut parts);
                        parts.push(Part::Case(change));
                    } else {
                        match e {
                            'n' => text.push('\n'),
                            't' => text.push('\t'),
                            '\\' => text.push('\\'),
                            other => {
                                text.push('\\');
                                text.push(other);
                            }
                        }
                    }
                    i += 2;
                }
                _ => {
                    text.push(c);
                    i += 1;
                }
            }
        }
        flush(&mut text, &mut parts);
        Template { parts }
    }

    pub fn render(&self, caps: &Captures<'_>) -> String {
        let mut out = String::new();
        let mut next: Option<CaseChange> = None;
        let mut span: Option<CaseChange> = None;
        for part in &self.parts {
            let piece = match part {
                Part::Text(text) => text.as_str(),
                Part::Group(n) => caps.get(*n).map_or("", |m| m.as_str()),
                Part::Named(name) => caps.name(name).map_or("", |m| m.as_str()),
                Part::Case(change) => {
                    match change {
                        CaseChange::UpperNext | CaseChange::LowerNext => next = Some(*change),
                        CaseChange::Upper | CaseChange::Lower => span = Some(*change),
                        CaseChange::End => span = None,
                    }
                    continue;
                }
            };
            let mut piece: String = match span {
                Some(CaseChange::Upper) => piece.to_uppercase(),
                Some(CaseChange::Lower) => piece.to_lowercase(),
                _ => piece.to_owned(),
            };
            if let Some(change) = next.filter(|_| !piece.is_empty()) {
                let mut chars = piece.chars();
                let first = chars.next().map(|c| match change {
                    CaseChange::UpperNext => c.to_uppercase().collect::<String>(),
                    _ => c.to_lowercase().collect::<String>(),
                });
                piece = format!("{}{}", first.unwrap_or_default(), chars.as_str());
                next = None;
            }
            out.push_str(&piece);
        }
        out
    }
}

/// A change to a document, in UTF-16 offsets (the editor's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Edit {
    pub from: u32,
    pub to: u32,
    pub insert: String,
}

/// The replacements in `text` (byte ranges), every match or only the one starting at byte `at`.
fn byte_edits(
    query: &Query,
    replacement: &str,
    text: &str,
    at: Option<usize>,
) -> Result<Vec<(std::ops::Range<usize>, String)>, SearchError> {
    let regex = replace_regex(query)?;
    let template = Template::parse(replacement, query.is_regex);
    let mut edits = Vec::new();
    for caps in regex.captures_iter(text) {
        let Some(whole) = caps.get(0) else { continue };
        if at.is_some_and(|at| whole.start() != at) {
            if at.is_some_and(|at| whole.start() > at) {
                break;
            }
            continue;
        }
        edits.push((whole.range(), template.render(&caps)));
        if at.is_some() {
            break;
        }
    }
    Ok(edits)
}

/// The edits that replace matches in an open document's `text`; `at` (a UTF-16 offset)
/// limits it to the match that starts there.
pub fn edits(
    query: &Query,
    replacement: &str,
    text: &str,
    at: Option<u32>,
) -> Result<Vec<Edit>, SearchError> {
    let at = at.map(|offset| byte_offset(text, offset as usize));
    let found = byte_edits(query, replacement, text, at)?;
    let mut edits = Vec::with_capacity(found.len());
    let (mut byte, mut unit) = (0usize, 0u32);
    for (range, insert) in found {
        unit += utf16_len(&text[byte..range.start]);
        let from = unit;
        unit += utf16_len(&text[range.start..range.end]);
        byte = range.end;
        edits.push(Edit {
            from,
            to: unit,
            insert,
        });
    }
    Ok(edits)
}

/// The byte offset of a UTF-16 offset.
fn byte_offset(text: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16();
    }
    text.len()
}

/// The byte offset of a 1-based line and 0-based UTF-16 column.
fn line_column_offset(text: &str, line: u32, column: u32) -> usize {
    let start = if line <= 1 {
        0
    } else {
        text.match_indices('\n')
            .nth(line as usize - 2)
            .map_or(text.len(), |(i, _)| i + 1)
    };
    start + byte_offset(&text[start..], column as usize)
}

/// Replaces matches in a file on disk, keeping its encoding, BOM and line endings; `at` limits
/// it to the match at that line and column. Returns how many were replaced.
pub fn replace_in_file(
    path: &Path,
    query: &Query,
    replacement: &str,
    at: Option<(u32, u32)>,
) -> Result<usize, SearchError> {
    let opened = files::read_text(path)?;
    let at = at.map(|(line, column)| line_column_offset(&opened.text, line, column));
    let found = byte_edits(query, replacement, &opened.text, at)?;
    if found.is_empty() {
        return Ok(0);
    }
    let mut text = String::with_capacity(opened.text.len());
    let mut last = 0;
    for (range, insert) in &found {
        text.push_str(&opened.text[last..range.start]);
        text.push_str(insert);
        last = range.end;
    }
    text.push_str(&opened.text[last..]);
    files::write_text(path, &text, &opened.format, Some(opened.stamp), false)?;
    Ok(found.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[derive(Default)]
    struct Collected(Mutex<Vec<SearchEvent>>);

    impl SearchSink for Collected {
        fn send(&self, event: SearchEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    impl Collected {
        fn files(&self) -> Vec<FileMatches> {
            let mut files: Vec<FileMatches> = self
                .0
                .lock()
                .unwrap()
                .iter()
                .flat_map(|e| match e {
                    SearchEvent::Files { files } => files.clone(),
                    SearchEvent::Done { .. } => Vec::new(),
                })
                .collect();
            files.sort_by(|a, b| a.path.cmp(&b.path));
            files
        }

        fn done(&self) -> (usize, bool, Option<String>) {
            match self.0.lock().unwrap().last() {
                Some(SearchEvent::Done {
                    matches,
                    limit_hit,
                    error,
                    ..
                }) => (*matches, *limit_hit, error.clone()),
                _ => panic!("no Done event"),
            }
        }
    }

    fn run(root: &Path, query: Query) -> Arc<Collected> {
        run_with(root, query, HashMap::new())
    }

    fn run_with(root: &Path, query: Query, unsaved: HashMap<PathBuf, String>) -> Arc<Collected> {
        let sink = Arc::new(Collected::default());
        search(
            root,
            &query,
            &unsaved,
            sink.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        sink
    }

    fn names(files: &[FileMatches], root: &Path) -> Vec<String> {
        files
            .iter()
            .map(|f| {
                Path::new(&f.path)
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    fn query(pattern: &str) -> Query {
        Query {
            pattern: pattern.into(),
            ..Query::default()
        }
    }

    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".gitignore"), "target/\n").unwrap();
        fs::write(
            root.join("src/main.rs"),
            "fn main() {\n    let total = add(1, 2);\n}\n",
        )
        .unwrap();
        fs::write(
            root.join("src/lib.rs"),
            "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
        )
        .unwrap();
        fs::write(root.join("target/out.rs"), "fn add() {}\n").unwrap();
        fs::write(root.join(".git/config"), "add = true\n").unwrap();
        fs::write(
            root.join("notes.md"),
            "Add more tests.\r\nThen add docs.\r\n",
        )
        .unwrap();
        fs::write(root.join("blob.bin"), b"add\0\x01\x02").unwrap();
        dir
    }

    #[test]
    fn finds_matches_and_skips_ignored_binary_and_git_files() {
        let dir = project();
        let root = dir.path();
        let found = run(root, query("add"));
        let files = found.files();
        assert_eq!(
            names(&files, root),
            ["notes.md", "src/lib.rs", "src/main.rs"]
        );
        let notes = &files[0];
        assert_eq!(notes.matches.len(), 2);
        let first = &notes.matches[0];
        assert_eq!((first.line, first.column, first.end_column), (1, 0, 3));
        assert_eq!(first.preview, "Add more tests.");
        let second = &notes.matches[1];
        assert_eq!((second.line, second.column), (2, 5));
        assert_eq!(found.done(), (4, false, None));
    }

    #[test]
    fn case_whole_word_and_regex() {
        let dir = project();
        let root = dir.path();
        let cased = run(
            root,
            Query {
                match_case: true,
                ..query("Add")
            },
        );
        assert_eq!(names(&cased.files(), root), ["notes.md"]);
        let word = run(
            root,
            Query {
                whole_word: true,
                ..query("a")
            },
        );
        assert_eq!(names(&word.files(), root), ["src/lib.rs"]);
        let regex = run(
            root,
            Query {
                is_regex: true,
                ..query(r"add\(\d")
            },
        );
        let files = regex.files();
        assert_eq!(names(&files, root), ["src/main.rs"]);
        assert_eq!(files[0].matches[0].preview, "let total = add(1, 2);");
        assert_eq!(files[0].matches[0].preview_start, 12);
        assert_eq!(files[0].matches[0].preview_len, 5);
        let broken = run(
            root,
            Query {
                is_regex: true,
                ..query("add(")
            },
        );
        assert!(broken.done().2.is_some());
    }

    #[test]
    fn include_and_exclude_globs() {
        let dir = project();
        let root = dir.path();
        let only_src = run(
            root,
            Query {
                include: vec!["src".into()],
                ..query("add")
            },
        );
        assert_eq!(
            names(&only_src.files(), root),
            ["src/lib.rs", "src/main.rs"]
        );
        let no_main = run(
            root,
            Query {
                include: vec!["*.rs".into()],
                exclude: vec!["main.rs".into()],
                ..query("add")
            },
        );
        assert_eq!(names(&no_main.files(), root), ["src/lib.rs"]);
        let everything = run(
            root,
            Query {
                use_ignore_files: false,
                ..query("add")
            },
        );
        assert_eq!(
            names(&everything.files(), root),
            ["notes.md", "src/lib.rs", "src/main.rs", "target/out.rs"]
        );
    }

    #[test]
    fn searches_utf16_files_and_unsaved_text() {
        let dir = project();
        let root = dir.path();
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "héllo add\r\n".encode_utf16() {
            utf16.extend(unit.to_le_bytes());
        }
        fs::write(root.join("wide.txt"), utf16).unwrap();
        let mut unsaved = HashMap::new();
        unsaved.insert(root.join("src/main.rs"), "nothing here\n".to_string());
        let found = run_with(root, query("add"), unsaved).files();
        assert_eq!(names(&found, root), ["notes.md", "src/lib.rs", "wide.txt"]);
        let wide = found.iter().find(|f| f.path.ends_with("wide.txt")).unwrap();
        assert_eq!((wide.matches[0].line, wide.matches[0].column), (1, 6));
    }

    #[test]
    fn stops_at_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("f{i}.txt")), "x x x\n").unwrap();
        }
        let found = run(
            dir.path(),
            Query {
                max_results: 10,
                ..query("x")
            },
        );
        let (matches, limit_hit, _) = found.done();
        assert!(limit_hit);
        assert!((10..=60).contains(&matches), "{matches}");
    }

    #[test]
    fn long_lines_get_a_window_around_the_match() {
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let (text, start, len) = preview(&line, 500, 506);
        assert!(text.starts_with('…'));
        assert_eq!(
            &text[text.char_indices().nth(start as usize).unwrap().0..][..6],
            "needle"
        );
        assert_eq!(len, 6);
        assert!(text.chars().count() <= PREVIEW_CHARS + 1);
    }

    #[test]
    fn templates_follow_vs_code() {
        let regex = Regex::new(r"(\w+)@(?<host>\w+)").unwrap();
        let caps = regex.captures("alice@example").unwrap();
        let render = |t: &str| Template::parse(t, true).render(&caps);
        assert_eq!(render("$2/$1"), "example/alice");
        assert_eq!(render("[$&] $$1"), "[alice@example] $1");
        assert_eq!(render("$<host>\\n\\t"), "example\n\t");
        assert_eq!(render("\\u$1 \\U$2\\E!"), "Alice EXAMPLE!");
        assert_eq!(Template::parse("$1 \\n", false).render(&caps), "$1 \\n");
    }

    #[test]
    fn edits_use_utf16_offsets() {
        let q = Query {
            is_regex: true,
            ..query(r"(\d+)")
        };
        let edits = edits(&q, "<$1>", "é 12 😀 345", None).unwrap();
        assert_eq!(
            edits,
            [
                Edit {
                    from: 2,
                    to: 4,
                    insert: "<12>".into()
                },
                Edit {
                    from: 8,
                    to: 11,
                    insert: "<345>".into()
                },
            ]
        );
        let only = super::edits(&q, "#", "é 12 😀 345", Some(8)).unwrap();
        assert_eq!(
            only,
            [Edit {
                from: 8,
                to: 11,
                insert: "#".into()
            }]
        );
    }

    #[test]
    fn replacing_in_a_file_keeps_its_format() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        fs::write(&path, b"\xEF\xBB\xBFone two\r\ntwo one\r\n").unwrap();
        let q = Query {
            whole_word: true,
            ..query("one")
        };
        assert_eq!(replace_in_file(&path, &q, "1", None).unwrap(), 2);
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBF1 two\r\ntwo 1\r\n");
        assert_eq!(
            replace_in_file(&path, &query("two"), "2", Some((2, 0))).unwrap(),
            1
        );
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBF1 two\r\n2 1\r\n");
    }
}

#[cfg(test)]
mod stress {
    use super::*;
    use std::fs;

    struct Count(Mutex<(usize, usize, Option<String>)>);

    impl SearchSink for Count {
        fn send(&self, event: SearchEvent) {
            let mut c = self.0.lock().unwrap();
            match event {
                SearchEvent::Files { files } => c.0 += files.len(),
                SearchEvent::Done { matches, error, .. } => {
                    c.1 = matches;
                    c.2 = error;
                }
            }
        }
    }

    /// 20,000 brand-new files, searched at once (antivirus is still scanning them).
    #[test]
    #[ignore = "slow; run with --ignored"]
    fn fresh_files_are_all_found() {
        let dir = tempfile::tempdir().unwrap();
        for d in 0..100 {
            let sub = dir.path().join(format!("m{d}"));
            fs::create_dir_all(&sub).unwrap();
            for f in 0..200 {
                fs::write(
                    sub.join(format!("c{f}.ts")),
                    format!("export const x = {f};\n"),
                )
                .unwrap();
            }
        }
        // A brand-new 10 MB file makes the first round wait for antivirus (26 s here).
        for round in 0..3 {
            let sink = Arc::new(Count(Mutex::new((0, 0, None))));
            let started = Instant::now();
            // The excludes the app sends by default.
            let exclude = ["**/.git", "**/node_modules", "**/*.code-search"];
            let q = Query {
                pattern: "x = 150;".into(),
                exclude: exclude.iter().map(|s| s.to_string()).collect(),
                ..Query::default()
            };
            search(
                dir.path(),
                &q,
                &HashMap::new(),
                sink.clone(),
                Arc::new(AtomicBool::new(false)),
            );
            let c = sink.0.lock().unwrap();
            println!(
                "round {round}: {} files, {} matches in {:?}",
                c.0,
                c.1,
                started.elapsed()
            );
            assert_eq!(c.0, 100);
        }
    }
}
