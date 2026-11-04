//! The open folder: a watcher that reports changes made on disk, and the list of its files that
//! quick open (Ctrl+P) searches.
//!
//! The list honours .gitignore (even outside a Git repository) and skips `.git`,
//! `node_modules` and similar folders. It's built on a background thread when the folder opens,
//! then kept up to date from the watcher's events.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache, new_debouncer,
};
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

/// Folders never listed for quick open (they're still shown in the explorer).
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "__pycache__",
    ".venv",
];

/// At most this many files are indexed; huge folders still open, quick open just stops there.
pub const MAX_FILES: usize = 300_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Created,
    Changed,
    Removed,
    /// The watcher lost track (its buffer overflowed): reload everything shown.
    Rescan,
    /// Something changed in `.git` that matters for source control (HEAD, index, refs).
    Git,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: ChangeKind,
    /// Absolute path.
    pub path: String,
}

/// Where the watcher's batches of changes go (a Tauri Channel in the app).
pub trait WatchSink: Send + Sync + 'static {
    fn changes(&self, changes: Vec<Change>);
}

/// A quick-open match.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatch {
    /// Relative to the folder, with `/`.
    pub path: String,
    pub score: u32,
    /// Matched character positions in `path`, for highlighting.
    pub indices: Vec<u32>,
}

pub struct Workspace {
    root: PathBuf,
    files: Arc<RwLock<Vec<String>>>,
    indexed: Arc<AtomicBool>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
}

impl Workspace {
    /// Opens a folder: starts indexing it in the background and watching it for changes.
    pub fn open(root: &Path, sink: Arc<dyn WatchSink>) -> std::io::Result<Arc<Workspace>> {
        let root = dunce::canonicalize(root)?;
        if !root.is_dir() {
            return Err(std::io::Error::other("That isn't a folder."));
        }
        let workspace = Arc::new(Workspace {
            root: root.clone(),
            files: Arc::new(RwLock::new(Vec::new())),
            indexed: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
        });

        let (files, indexed, index_root) = (
            workspace.files.clone(),
            workspace.indexed.clone(),
            root.clone(),
        );
        std::thread::spawn(move || {
            let list = index(&index_root);
            *files.write().unwrap_or_else(|p| p.into_inner()) = list;
            indexed.store(true, Ordering::SeqCst);
        });

        let (files, watch_root) = (workspace.files.clone(), root.clone());
        let mut debouncer = new_debouncer(
            Duration::from_millis(120),
            None,
            move |result: DebounceEventResult| {
                let changes = match result {
                    Ok(events) => to_changes(&watch_root, &events),
                    Err(_) => vec![Change {
                        kind: ChangeKind::Rescan,
                        path: watch_root.display().to_string(),
                    }],
                };
                if changes.is_empty() {
                    return;
                }
                update_index(&watch_root, &files, &changes);
                sink.changes(changes);
            },
        )
        .map_err(std::io::Error::other)?;
        debouncer
            .watch(&root, RecursiveMode::Recursive)
            .map_err(std::io::Error::other)?;
        *workspace.watcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(debouncer);
        Ok(workspace)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// True once the background index is complete.
    pub fn is_indexed(&self) -> bool {
        self.indexed.load(Ordering::SeqCst)
    }

    pub fn file_count(&self) -> usize {
        self.files.read().map(|f| f.len()).unwrap_or_default()
    }

    /// Fuzzy-matches `query` against every indexed file, best first. Matches in the file name
    /// rank above matches spread across folders.
    pub fn find_files(&self, query: &str, limit: usize) -> Vec<FileMatch> {
        let files = self.files.read().unwrap_or_else(|p| p.into_inner());
        find_in(&files, query, limit)
    }

    /// Stops watching (also happens when the workspace is dropped).
    pub fn close(&self) {
        if let Some(debouncer) = self
            .watcher
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
        {
            debouncer.stop();
        }
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        self.close();
    }
}

/// Lists a folder's files (relative, with `/`), honouring .gitignore and skipping tool folders.
pub fn index(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .ignore(true)
        .parents(false)
        .filter_entry(|entry| {
            let skipped = entry.file_type().is_some_and(|t| t.is_dir())
                && SKIPPED_DIRS
                    .iter()
                    .any(|name| entry.file_name().eq_ignore_ascii_case(name));
            !skipped
        })
        .build();
    for entry in walker.flatten() {
        if files.len() >= MAX_FILES {
            break;
        }
        if entry.file_type().is_some_and(|t| t.is_file())
            && let Some(relative) = relative_posix(root, entry.path())
        {
            files.push(relative);
        }
    }
    files.sort_unstable();
    files
}

fn find_in(files: &[String], query: &str, limit: usize) -> Vec<FileMatch> {
    let query = query.trim();
    if query.is_empty() {
        return files
            .iter()
            .take(limit)
            .map(|path| FileMatch {
                path: path.clone(),
                score: 0,
                indices: Vec::new(),
            })
            .collect();
    }
    // Backslashes typed out of habit mean folders too.
    let query = query.replace('\\', "/");
    let pattern = Pattern::parse(&query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut scored: Vec<(u32, usize)> = Vec::new();
    for (i, path) in files.iter().enumerate() {
        let Some(score) = pattern.score(Utf32Str::new(path, &mut buf), &mut matcher) else {
            continue;
        };
        let name = path.rsplit('/').next().unwrap_or(path);
        let name_bonus = pattern
            .score(Utf32Str::new(name, &mut buf), &mut matcher)
            .unwrap_or(0);
        scored.push((score + name_bonus, i));
    }
    scored.sort_unstable_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| files[a.1].len().cmp(&files[b.1].len()))
    });
    scored.truncate(limit);
    scored
        .into_iter()
        .map(|(score, i)| {
            let mut indices = Vec::new();
            pattern.indices(
                Utf32Str::new(&files[i], &mut buf),
                &mut matcher,
                &mut indices,
            );
            indices.sort_unstable();
            indices.dedup();
            FileMatch {
                path: files[i].clone(),
                score,
                indices,
            }
        })
        .collect()
}

fn relative_posix(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let text = relative.to_string_lossy().replace('\\', "/");
    (!text.is_empty()).then_some(text)
}

/// Turns the watcher's events into changes for the UI. Inside `.git`, only what source control
/// cares about is reported (once per batch).
fn to_changes(root: &Path, events: &[DebouncedEvent]) -> Vec<Change> {
    let mut changes: Vec<Change> = Vec::new();
    let mut git = false;
    let mut push = |kind: ChangeKind, path: &Path| {
        let relative = path.strip_prefix(root).unwrap_or(path);
        let mut parts = relative.components();
        if parts
            .next()
            .is_some_and(|first| first.as_os_str().eq_ignore_ascii_case(".git"))
        {
            let rest = parts.as_path().to_string_lossy().to_ascii_lowercase();
            if rest == "head" || rest == "index" || rest.starts_with("refs") {
                git = true;
            }
            return;
        }
        let change = Change {
            kind,
            path: path.display().to_string(),
        };
        if !changes.contains(&change) {
            changes.push(change);
        }
    };
    for event in events {
        if event.need_rescan() {
            push(ChangeKind::Rescan, root);
            continue;
        }
        match &event.kind {
            EventKind::Create(_) => event
                .paths
                .iter()
                .for_each(|p| push(ChangeKind::Created, p)),
            EventKind::Remove(_) => event
                .paths
                .iter()
                .for_each(|p| push(ChangeKind::Removed, p)),
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
                .paths
                .iter()
                .for_each(|p| push(ChangeKind::Removed, p)),
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
                .paths
                .iter()
                .for_each(|p| push(ChangeKind::Created, p)),
            EventKind::Modify(ModifyKind::Name(_)) if event.paths.len() == 2 => {
                push(ChangeKind::Removed, &event.paths[0]);
                push(ChangeKind::Created, &event.paths[1]);
            }
            EventKind::Modify(_) => event
                .paths
                .iter()
                .for_each(|p| push(ChangeKind::Changed, p)),
            _ => {}
        }
    }
    if git {
        changes.push(Change {
            kind: ChangeKind::Git,
            path: root.join(".git").display().to_string(),
        });
    }
    changes
}

fn update_index(root: &Path, files: &RwLock<Vec<String>>, changes: &[Change]) {
    if changes.iter().any(|c| c.kind == ChangeKind::Rescan) {
        let list = index(root);
        *files.write().unwrap_or_else(|p| p.into_inner()) = list;
        return;
    }
    let mut files = files.write().unwrap_or_else(|p| p.into_inner());
    for change in changes {
        let path = Path::new(&change.path);
        let Some(relative) = relative_posix(root, path) else {
            continue;
        };
        let skipped = relative.split('/').any(|part| {
            SKIPPED_DIRS
                .iter()
                .any(|name| part.eq_ignore_ascii_case(name))
        });
        match change.kind {
            ChangeKind::Created if !skipped && path.is_file() => {
                if let Err(at) = files.binary_search(&relative)
                    && files.len() < MAX_FILES
                {
                    files.insert(at, relative);
                }
            }
            ChangeKind::Removed => {
                let folder = format!("{relative}/");
                files.retain(|f| f != &relative && !f.starts_with(&folder));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct ToChannel(Mutex<mpsc::Sender<Vec<Change>>>);
    impl WatchSink for ToChannel {
        fn changes(&self, changes: Vec<Change>) {
            let _ = self.0.lock().unwrap().send(changes);
        }
    }

    fn files(dir: &Path, names: &[&str]) {
        for name in names {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
    }

    #[test]
    fn the_index_honours_gitignore_and_skips_tool_folders() {
        let dir = tempfile::tempdir().unwrap();
        files(
            dir.path(),
            &[
                "src/main.rs",
                "src/lib.rs",
                "target/debug/app.exe",
                "node_modules/pkg/index.js",
                ".git/HEAD",
                ".env",
                "README.md",
            ],
        );
        std::fs::write(dir.path().join(".gitignore"), "target/\n").unwrap();
        let list = index(dir.path());
        assert_eq!(
            list,
            [
                ".env",
                ".gitignore",
                "README.md",
                "src/lib.rs",
                "src/main.rs"
            ]
        );
    }

    #[test]
    fn fuzzy_matches_rank_file_names_first() {
        let list: Vec<String> = [
            "src/editor/theme.ts",
            "src/theme/editor.ts",
            "docs/the-mess.md",
            "src/workbench/TitleBar.tsx",
        ]
        .map(String::from)
        .to_vec();
        let found = find_in(&list, "theme", 10);
        assert_eq!(found[0].path, "src/editor/theme.ts");
        assert!(found.iter().all(|m| !m.indices.is_empty()));
        assert_eq!(
            find_in(&list, "tbar", 10)[0].path,
            "src/workbench/TitleBar.tsx"
        );
        assert!(find_in(&list, "zzz", 10).is_empty());
    }

    #[test]
    fn changes_on_disk_reach_the_sink_and_the_index() {
        let dir = tempfile::tempdir().unwrap();
        files(dir.path(), &["a.txt"]);
        let (tx, rx) = mpsc::channel();
        let workspace = Workspace::open(dir.path(), Arc::new(ToChannel(Mutex::new(tx)))).unwrap();
        for _ in 0..100 {
            if workspace.is_indexed() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(workspace.file_count(), 1);

        std::fs::write(dir.path().join("b.txt"), "new").unwrap();
        let mut seen = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline
            && !seen
                .iter()
                .any(|c: &Change| c.kind == ChangeKind::Created && c.path.ends_with("b.txt"))
        {
            if let Ok(batch) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.extend(batch);
            }
        }
        assert!(
            seen.iter()
                .any(|c| c.kind == ChangeKind::Created && c.path.ends_with("b.txt")),
            "{seen:?}"
        );
        assert_eq!(workspace.find_files("b.txt", 5)[0].path, "b.txt");
        workspace.close();
    }
}
