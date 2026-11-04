//! Files as the editor reads and writes them.
//!
//! Text is decoded to `\n` line endings and saved back in the file's own encoding, byte-order
//! mark and line endings (`text::TextFile`). Saving writes a temporary file next to the target,
//! flushes it and swaps it in with `ReplaceFileW`, which keeps the original's permissions,
//! creation time and alternate data streams (Folio's approach), retrying briefly while
//! antivirus or the indexer holds the file. A save first checks that no other program changed
//! the file since the editor last read or wrote it.

use std::cmp::Ordering;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use windows::Win32::Storage::FileSystem::{
    MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_IGNORE_ACL_ERRORS,
    REPLACEFILE_IGNORE_MERGE_ERRORS, REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
};
use windows::core::{HSTRING, PCWSTR};

use crate::text::{self, TextError, TextFile};

/// Bigger files don't open as text (CodeMirror copes, but the whole file travels over IPC).
pub const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;

const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("This is a binary file, not text.")]
    Binary,
    #[error("The file is too big to open as text ({0} MB).")]
    TooLarge(u64),
    #[error("The file changed on disk since it was opened.")]
    Conflict,
    #[error("The file is read-only.")]
    ReadOnly,
    #[error("The text has characters that {0} can't store.")]
    Unencodable(&'static str),
    #[error("{0} already exists.")]
    Exists(String),
    #[error("{0}")]
    Invalid(String),
}

impl FileError {
    /// Stable, machine-readable kind for the UI.
    pub fn kind(&self) -> &'static str {
        match self {
            FileError::Io(err) if err.kind() == io::ErrorKind::NotFound => "notFound",
            FileError::Io(_) => "io",
            FileError::Binary => "binary",
            FileError::TooLarge(_) => "tooLarge",
            FileError::Conflict => "conflict",
            FileError::ReadOnly => "readOnly",
            FileError::Unencodable(_) => "unencodable",
            FileError::Exists(_) => "exists",
            FileError::Invalid(_) => "invalid",
        }
    }
}

impl From<TextError> for FileError {
    fn from(err: TextError) -> Self {
        match err {
            TextError::Binary => FileError::Binary,
            TextError::Io(message) => FileError::Io(io::Error::other(message)),
            TextError::Unencodable(name) => FileError::Unencodable(name),
        }
    }
}

/// When a file last changed, as the editor saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stamp {
    /// Last write time, in milliseconds since the Unix epoch.
    pub mtime: i64,
    pub size: u64,
}

impl Stamp {
    pub fn of(path: &Path) -> io::Result<Stamp> {
        Ok(Stamp::from_metadata(&fs::metadata(path)?))
    }

    fn from_metadata(meta: &fs::Metadata) -> Stamp {
        Stamp {
            mtime: mtime_ms(meta),
            size: meta.len(),
        }
    }
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// How a text file is stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    /// The encoding's canonical name: "UTF-8", "UTF-16LE", "windows-1252"…
    pub encoding: String,
    pub bom: bool,
    pub crlf: bool,
}

impl TextFormat {
    /// The format for a new file at `path`: UTF-8 without a BOM, with the line endings most of
    /// its neighbours use.
    pub fn for_new_file(path: &Path) -> TextFormat {
        TextFormat {
            encoding: "UTF-8".into(),
            bom: false,
            crlf: text::sibling_line_endings(path),
        }
    }
}

/// A text file's content (with `\n` line endings) and how it's stored.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedText {
    pub text: String,
    pub format: TextFormat,
    pub stamp: Stamp,
    pub read_only: bool,
}

pub fn read_text(path: &Path) -> Result<OpenedText, FileError> {
    let meta = fs::metadata(path)?;
    if meta.is_dir() {
        return Err(FileError::Invalid("That's a folder, not a file.".into()));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(FileError::TooLarge(meta.len() / (1024 * 1024)));
    }
    let bytes = fs::read(path)?;
    let file = TextFile::decode(&bytes)?;
    let format = TextFormat {
        encoding: file.encoding_name().into(),
        bom: file.bom(),
        crlf: file.crlf(),
    };
    Ok(OpenedText {
        text: file.text,
        format,
        stamp: Stamp::from_metadata(&meta),
        read_only: meta.permissions().readonly(),
    })
}

/// Saves `text` (with `\n` line endings) to `path` in `format` and returns the new stamp.
///
/// Fails with [`FileError::Conflict`] if `expected` is given and the file on disk no longer
/// matches it (another program changed it), unless `force` is set (you chose "Overwrite").
pub fn write_text(
    path: &Path,
    text: &str,
    format: &TextFormat,
    expected: Option<Stamp>,
    force: bool,
) -> Result<Stamp, FileError> {
    let bytes = TextFile::with_format(&format.encoding, format.bom, format.crlf).encode(text)?;
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            return Err(FileError::ReadOnly);
        }
        if let Some(expected) = expected
            && !force
            && Stamp::from_metadata(&meta) != expected
        {
            return Err(FileError::Conflict);
        }
    }
    write_atomic(path, &bytes)?;
    Ok(Stamp::of(path)?)
}

/// Writes `bytes` to `target` so that it is always either the old file or the new one, never
/// half of either. Missing parent folders are created. Sharing violations (antivirus, the
/// search indexer) are retried three times, 100 ms apart.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = dir.join(format!(".{name}.lathe-{}.tmp", crate::new_id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let mut attempt = 0;
        loop {
            match swap_in(target, &temp) {
                Ok(()) => return Ok(()),
                Err(err) if attempt < 3 && is_transient(&err) => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(err) => return Err(err),
            }
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn swap_in(target: &Path, temp: &Path) -> io::Result<()> {
    let target_w = HSTRING::from(target.as_os_str());
    let temp_w = HSTRING::from(temp.as_os_str());
    // SAFETY: valid, NUL-terminated paths; no optional pointers.
    let result = unsafe {
        if target.exists() {
            ReplaceFileW(
                &target_w,
                &temp_w,
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH
                    | REPLACEFILE_IGNORE_MERGE_ERRORS
                    | REPLACEFILE_IGNORE_ACL_ERRORS,
                None,
                None,
            )
        } else {
            MoveFileExW(&temp_w, &target_w, MOVEFILE_WRITE_THROUGH)
        }
    };
    result.map_err(win32_error)
}

/// A Windows error (an HRESULT wrapping a Win32 code) as an `io::Error` with the Win32 code.
fn win32_error(err: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error((err.code().0 as u32 & 0xFFFF) as i32)
}

/// Errors that usually clear up on their own a moment later.
fn is_transient(err: &io::Error) -> bool {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION, ERROR_USER_MAPPED_FILE
    matches!(err.raw_os_error(), Some(5 | 32 | 33 | 1224))
}

/// One entry of a folder listing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    /// A symbolic link or junction (`dir` and `size` describe its target).
    pub link: bool,
    pub hidden: bool,
    pub size: u64,
    pub mtime: i64,
}

/// A folder's entries: folders first, then files, each in natural order ("file2" before
/// "file10"), ignoring case.
pub fn read_dir(path: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(path)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(kind) = item.file_type() else { continue };
        let link = kind.is_symlink();
        let meta = if link {
            // A broken link still shows (as an empty file), so you can delete it.
            fs::metadata(item.path()).or_else(|_| item.metadata())
        } else {
            item.metadata()
        };
        let Ok(meta) = meta else { continue };
        entries.push(Entry {
            name,
            dir: meta.is_dir(),
            link,
            hidden: meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0,
            size: if meta.is_dir() { 0 } else { meta.len() },
            mtime: mtime_ms(&meta),
        });
    }
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    Ok(entries)
}

/// Compares names the way people read them: case-insensitively, with runs of digits compared
/// as numbers.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        it.next();
                    }
                    digits
                };
                let (da, db) = (take(&mut a), take(&mut b));
                let (ta, tb) = (da.trim_start_matches('0'), db.trim_start_matches('0'));
                let order = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// Creates an empty file (and any missing folders above it). Fails if it already exists.
pub fn create_file(path: &Path) -> Result<(), FileError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(exists(path)),
        Err(err) => Err(err.into()),
    }
}

/// Creates a folder (and any missing folders above it). Fails if it already exists.
pub fn create_dir(path: &Path) -> Result<(), FileError> {
    if path.exists() {
        return Err(exists(path));
    }
    fs::create_dir_all(path)?;
    Ok(())
}

/// Renames or moves `from` to `to`. Fails if `to` exists, unless only the name's case changes.
pub fn rename(from: &Path, to: &Path) -> Result<(), FileError> {
    if to.exists() && !same_file(from, to) {
        return Err(exists(to));
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(from, to)?;
    Ok(())
}

/// Deletes files and folders: to the Recycle Bin, or for good.
pub fn delete(paths: &[PathBuf], to_trash: bool) -> Result<(), FileError> {
    if to_trash {
        return trash::delete_all(paths)
            .map_err(|err| FileError::Io(io::Error::other(err.to_string())));
    }
    for path in paths {
        let meta = fs::symlink_metadata(path)?;
        if meta.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Copies files and folders into `target_dir`. A name that's taken gets " copy" (then " copy 2"
/// and so on) before its extension, as when you duplicate a file. Returns the new paths.
pub fn copy_into(sources: &[PathBuf], target_dir: &Path) -> Result<Vec<PathBuf>, FileError> {
    let mut created = Vec::new();
    for source in sources {
        if target_dir.starts_with(source) {
            return Err(FileError::Invalid(format!(
                "Can't copy {} into itself.",
                source.display()
            )));
        }
        let name = source
            .file_name()
            .ok_or_else(|| FileError::Invalid(format!("{} has no name.", source.display())))?;
        let dest = unique_path(&target_dir.join(name));
        copy_recursive(source, &dest)?;
        created.push(dest);
    }
    Ok(created)
}

/// Moves files and folders into `target_dir`. Fails (before moving anything) if a name is
/// taken there. Returns the new paths.
pub fn move_into(sources: &[PathBuf], target_dir: &Path) -> Result<Vec<PathBuf>, FileError> {
    let mut plan = Vec::new();
    for source in sources {
        let name = source
            .file_name()
            .ok_or_else(|| FileError::Invalid(format!("{} has no name.", source.display())))?;
        if target_dir.starts_with(source) {
            return Err(FileError::Invalid(format!(
                "Can't move {} into itself.",
                source.display()
            )));
        }
        let dest = target_dir.join(name);
        if dest.exists() && !same_file(source, &dest) {
            return Err(exists(&dest));
        }
        plan.push((source, dest));
    }
    let mut moved = Vec::new();
    for (source, dest) in plan {
        if fs::rename(source, &dest).is_err() {
            // Another drive: copy, then delete the original.
            copy_recursive(source, &dest)?;
            delete(std::slice::from_ref(source), false)?;
        }
        moved.push(dest);
    }
    Ok(moved)
}

fn copy_recursive(source: &Path, dest: &Path) -> io::Result<()> {
    if fs::metadata(source)?.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else {
        fs::copy(source, dest)?;
    }
    Ok(())
}

/// `path` if it's free, else "name copy.ext", "name copy 2.ext"…
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new(""));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    // A folder, or a dotfile like ".env", keeps its whole name as the stem.
    let (stem, ext) = if path.is_dir() || stem.is_empty() {
        (
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            String::new(),
        )
    } else {
        (stem, ext)
    };
    for n in 1.. {
        let suffix = if n == 1 {
            " copy".to_string()
        } else {
            format!(" copy {n}")
        };
        let candidate = parent.join(format!("{stem}{suffix}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// True when two paths name the same file (Windows paths ignore case).
fn same_file(a: &Path, b: &Path) -> bool {
    match (dunce::canonicalize(a), dunce::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn exists(path: &Path) -> FileError {
    FileError::Exists(
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn natural_order_sorts_numbers_by_value_and_ignores_case() {
        let mut names = vec!["file10.txt", "File2.txt", "file1.txt", "alpha", "Beta"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            ["alpha", "Beta", "file1.txt", "File2.txt", "file10.txt"]
        );
    }

    #[test]
    fn text_round_trips_with_crlf_and_bom_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crlf.txt");
        fs::write(&path, b"\xEF\xBB\xBFone\r\ntwo\r\n").unwrap();
        let opened = read_text(&path).unwrap();
        assert_eq!(opened.text, "one\ntwo\n");
        assert_eq!(
            opened.format,
            TextFormat {
                encoding: "UTF-8".into(),
                bom: true,
                crlf: true
            }
        );
        write_text(
            &path,
            "one\ntwo\nthree\n",
            &opened.format,
            Some(opened.stamp),
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"\xEF\xBB\xBFone\r\ntwo\r\nthree\r\n"
        );
    }

    #[test]
    fn utf16_files_stay_utf16() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.txt");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "hé\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&path, &bytes).unwrap();
        let opened = read_text(&path).unwrap();
        assert_eq!(opened.format.encoding, "UTF-16LE");
        write_text(&path, "hé\n", &opened.format, None, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn a_save_after_another_program_changed_the_file_is_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        fs::write(&path, "one").unwrap();
        let opened = read_text(&path).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&path, "changed elsewhere").unwrap();
        let err = write_text(&path, "mine", &opened.format, Some(opened.stamp), false).unwrap_err();
        assert_eq!(err.kind(), "conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "changed elsewhere");
        write_text(&path, "mine", &opened.format, Some(opened.stamp), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
    }

    #[test]
    fn read_only_files_are_refused_and_binary_files_are_not_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ro.txt");
        fs::write(&path, "x").unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms.clone()).unwrap();
        let format = TextFormat::for_new_file(&path);
        assert_eq!(
            write_text(&path, "y", &format, None, false)
                .unwrap_err()
                .kind(),
            "readOnly"
        );
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();

        let binary = dir.path().join("b.bin");
        fs::write(&binary, [0u8, 1, 2, 3]).unwrap();
        assert_eq!(read_text(&binary).unwrap_err().kind(), "binary");
    }

    #[test]
    fn listing_puts_folders_first_and_copies_get_unique_names() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::create_dir(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        let names: Vec<String> = read_dir(dir.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["src", "a.txt", "b.txt"]);

        let copies = copy_into(&[dir.path().join("a.txt")], dir.path()).unwrap();
        assert_eq!(copies[0].file_name().unwrap(), "a copy.txt");
        let copies = copy_into(&[dir.path().join("a.txt")], dir.path()).unwrap();
        assert_eq!(copies[0].file_name().unwrap(), "a copy 2.txt");
        let copies = copy_into(&[dir.path().join("src")], dir.path()).unwrap();
        assert_eq!(copies[0].file_name().unwrap(), "src copy");
        assert!(copy_into(&[dir.path().join("src")], &dir.path().join("src")).is_err());
    }

    #[test]
    fn create_rename_and_move_refuse_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("nested/deeper/a.txt");
        create_file(&a).unwrap();
        assert_eq!(create_file(&a).unwrap_err().kind(), "exists");
        let b = dir.path().join("b.txt");
        fs::write(&b, "b").unwrap();
        assert_eq!(rename(&b, &a).unwrap_err().kind(), "exists");
        // Changing only the case of a name is allowed.
        rename(&b, &dir.path().join("B.txt")).unwrap();
        assert!(
            read_dir(dir.path())
                .unwrap()
                .iter()
                .any(|e| e.name == "B.txt")
        );
        let moved = move_into(&[dir.path().join("B.txt")], &dir.path().join("nested")).unwrap();
        assert!(moved[0].ends_with("nested/B.txt"));
        delete(&moved, false).unwrap();
        assert!(!moved[0].exists());
    }
}
