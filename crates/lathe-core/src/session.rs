//! What was open last time (`session.json`), recent folders, and the text of unsaved editors
//! (`backups/`), so Lathe starts where you left off, even after a crash or a restart with
//! unsaved work ("hot exit"). The UI owns the session's shape; this store keeps it safe.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::files::write_atomic;

/// At most this many recent folders are remembered.
pub const MAX_RECENT: usize = 20;

pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// The last saved session, or `null` the first time (or if the file is damaged).
    pub fn load(&self) -> Value {
        std::fs::read_to_string(self.dir.join("session.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }

    pub fn save(&self, session: &Value) -> std::io::Result<()> {
        let text = serde_json::to_string(session).unwrap_or_else(|_| "null".into());
        write_atomic(&self.dir.join("session.json"), text.as_bytes())
    }

    /// Keeps an unsaved editor's text under `id` (letters, digits and dashes only).
    pub fn save_buffer(&self, id: &str, text: &str) -> std::io::Result<()> {
        let path = self.buffer_path(id)?;
        write_atomic(&path, text.as_bytes())
    }

    pub fn load_buffer(&self, id: &str) -> Option<String> {
        std::fs::read_to_string(self.buffer_path(id).ok()?).ok()
    }

    pub fn remove_buffer(&self, id: &str) {
        if let Ok(path) = self.buffer_path(id) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Deletes kept buffers that the session no longer mentions.
    pub fn prune_buffers(&self, keep: &[String]) {
        let Ok(entries) = std::fs::read_dir(self.dir.join("backups")) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".txt") else {
                continue;
            };
            if !keep.iter().any(|k| k == id) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Recent folders, most recent first.
    pub fn recent_folders(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("recent.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|path| Path::new(path).is_dir())
            .collect()
    }

    pub fn add_recent_folder(&self, path: &str) -> std::io::Result<Vec<String>> {
        let mut recent = self.recent_folders();
        recent.retain(|p| !p.eq_ignore_ascii_case(path));
        recent.insert(0, path.to_owned());
        recent.truncate(MAX_RECENT);
        let text = serde_json::to_string(&recent).unwrap_or_else(|_| "[]".into());
        write_atomic(&self.dir.join("recent.json"), text.as_bytes())?;
        Ok(recent)
    }

    pub fn remove_recent_folder(&self, path: &str) -> std::io::Result<Vec<String>> {
        let mut recent = self.recent_folders();
        recent.retain(|p| !p.eq_ignore_ascii_case(path));
        let text = serde_json::to_string(&recent).unwrap_or_else(|_| "[]".into());
        write_atomic(&self.dir.join("recent.json"), text.as_bytes())?;
        Ok(recent)
    }

    /// True when you said you trust this folder's code (tasks, the Run button, debuggers and
    /// language servers can run things from it).
    pub fn is_trusted(&self, folder: &str) -> bool {
        self.trusted()
            .iter()
            .any(|p| p.eq_ignore_ascii_case(folder))
    }

    pub fn set_trusted(&self, folder: &str, trusted: bool) -> std::io::Result<()> {
        let mut list = self.trusted();
        list.retain(|p| !p.eq_ignore_ascii_case(folder));
        if trusted {
            list.push(folder.to_owned());
        }
        let text = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
        write_atomic(&self.dir.join("trusted.json"), text.as_bytes())
    }

    fn trusted(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("trusted.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn buffer_path(&self, id: &str) -> std::io::Result<PathBuf> {
        let valid = !id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return Err(std::io::Error::other("invalid buffer id"));
        }
        Ok(self.dir.join("backups").join(format!("{id}.txt")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sessions_buffers_and_recent_folders_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        assert_eq!(store.load(), Value::Null);
        store
            .save(&json!({"folder": "C:/x", "editors": []}))
            .unwrap();
        store.save_buffer("abc-123", "unsaved text").unwrap();
        assert!(store.save_buffer("../evil", "x").is_err());

        let again = SessionStore::new(dir.path());
        assert_eq!(again.load(), json!({"folder": "C:/x", "editors": []}));
        assert_eq!(
            again.load_buffer("abc-123").as_deref(),
            Some("unsaved text")
        );
        again.prune_buffers(&[]);
        assert_eq!(again.load_buffer("abc-123"), None);

        let folder = dir.path().display().to_string();
        let recent = again.add_recent_folder(&folder).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0], folder);
        assert_eq!(again.add_recent_folder(&folder).unwrap().len(), 1);
        assert!(again.remove_recent_folder(&folder).unwrap().is_empty());
    }
}
