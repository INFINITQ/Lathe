//! Local history: a copy of a file's text each time Lathe saves it, kept in the data folder so
//! you can look back at an earlier version and restore it, Git or not. Up to 50 copies per
//! file, none older than 30 days, and a save that changes nothing adds nothing.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

const KEEP: usize = 50;
const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: String,
    /// Milliseconds since 1970.
    pub time: i64,
    pub size: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The folder for one file's copies (named by a hash of its path, which Windows compares
/// case-insensitively).
fn folder(data_dir: &Path, path: &Path) -> PathBuf {
    let key = path.to_string_lossy().to_lowercase();
    let digest = Sha256::digest(key.as_bytes());
    data_dir.join("history").join(&hex(&digest)[..20])
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn entries(dir: &Path) -> Vec<(i64, PathBuf, u64)> {
    let mut found: Vec<(i64, PathBuf, u64)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let time: i64 = path.file_stem()?.to_str()?.parse().ok()?;
            (path.extension()? == "txt").then(|| {
                (
                    time,
                    path.clone(),
                    entry.metadata().map(|m| m.len()).unwrap_or(0),
                )
            })
        })
        .collect();
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found
}

/// Keeps `text` as the newest copy of `path`.
pub fn record(data_dir: &Path, path: &Path, text: &str) -> io::Result<()> {
    let dir = folder(data_dir, path);
    fs::create_dir_all(&dir)?;
    let existing = entries(&dir);
    if let Some((_, newest, _)) = existing.first()
        && fs::read_to_string(newest).is_ok_and(|old| old == text)
    {
        return Ok(());
    }
    // Which file this folder is for, so the history can be listed without the hash.
    let _ = fs::write(dir.join("path"), path.to_string_lossy().as_bytes());
    let mut time = now_ms();
    if existing.first().is_some_and(|(t, _, _)| *t >= time) {
        time = existing[0].0 + 1;
    }
    fs::write(dir.join(format!("{time}.txt")), text)?;
    let cutoff = now_ms() - MAX_AGE.as_millis() as i64;
    for (i, (t, file, _)) in entries(&dir).into_iter().enumerate() {
        if i >= KEEP || t < cutoff {
            let _ = fs::remove_file(file);
        }
    }
    Ok(())
}

/// The copies of `path`, newest first.
pub fn list(data_dir: &Path, path: &Path) -> Vec<Entry> {
    entries(&folder(data_dir, path))
        .into_iter()
        .map(|(time, _, size)| Entry {
            id: time.to_string(),
            time,
            size,
        })
        .collect()
}

pub fn read(data_dir: &Path, path: &Path, id: &str) -> io::Result<String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a history entry",
        ));
    }
    fs::read_to_string(folder(data_dir, path).join(format!("{id}.txt")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_each_new_version_and_skips_repeats() {
        let data = tempfile::tempdir().unwrap();
        let file = Path::new("C:\\proj\\Main.py");
        record(data.path(), file, "v1").unwrap();
        record(data.path(), file, "v1").unwrap();
        record(data.path(), file, "v2").unwrap();
        // The same file, spelled differently.
        let listed = list(data.path(), Path::new("c:\\PROJ\\main.py"));
        assert_eq!(listed.len(), 2);
        assert_eq!(read(data.path(), file, &listed[0].id).unwrap(), "v2");
        assert_eq!(read(data.path(), file, &listed[1].id).unwrap(), "v1");
        assert!(read(data.path(), file, "../escape").is_err());
    }

    #[test]
    fn keeps_at_most_fifty() {
        let data = tempfile::tempdir().unwrap();
        let file = Path::new("C:\\proj\\a.txt");
        for i in 0..60 {
            record(data.path(), file, &format!("v{i}")).unwrap();
        }
        let listed = list(data.path(), file);
        assert_eq!(listed.len(), 50);
        assert_eq!(read(data.path(), file, &listed[0].id).unwrap(), "v59");
    }
}
