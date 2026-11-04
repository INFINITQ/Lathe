//! Settings files: one for you, and `.lathe/settings.json` in a folder. Both are JSONC with flat
//! keys such as `"editor.fontSize"`, as in VS Code. The UI knows every setting's default and
//! schema; this store only keeps what the files say.
//!
//! A file with a syntax error is never overwritten: its last good values stay in effect and
//! changes are refused until it's fixed, so a half-finished hand edit is never lost.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::jsonc;

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{file} has an error ({message}). Fix it, then try again.")]
    Damaged { file: String, message: String },
}

/// What a settings file holds right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub path: String,
    pub values: Value,
    /// Set while the file on disk doesn't parse; `values` are the last good ones.
    pub error: Option<String>,
}

pub struct SettingsFile {
    path: PathBuf,
    state: Mutex<State>,
}

struct State {
    values: Value,
    error: Option<String>,
}

impl SettingsFile {
    /// Opens a settings file; a missing one is empty.
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (values, error) = match read(&path) {
            Ok(values) => (values, None),
            Err(message) => (Value::Object(Map::new()), Some(message)),
        };
        Self {
            path,
            state: Mutex::new(State { values, error }),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn snapshot(&self) -> Snapshot {
        let state = self.lock();
        Snapshot {
            path: self.path.display().to_string(),
            values: state.values.clone(),
            error: state.error.clone(),
        }
    }

    /// Applies a JSON merge patch (`null` resets a setting to its default) and saves.
    pub fn update(&self, patch: &Value) -> Result<Snapshot, SettingsError> {
        let mut state = self.lock();
        // Re-read first, so a hand edit made since the last read isn't overwritten.
        match read(&self.path) {
            Ok(values) => {
                state.values = values;
                state.error = None;
            }
            Err(message) => {
                state.error = Some(message.clone());
                return Err(SettingsError::Damaged {
                    file: self.file_name(),
                    message,
                });
            }
        }
        jsonc::merge_patch(&mut state.values, patch);
        let mut text = serde_json::to_string_pretty(&state.values).unwrap_or_else(|_| "{}".into());
        text.push('\n');
        crate::files::write_atomic(&self.path, text.as_bytes())?;
        drop(state);
        Ok(self.snapshot())
    }

    /// Re-reads the file after an edit outside the settings UI.
    pub fn reload(&self) -> Snapshot {
        let mut state = self.lock();
        match read(&self.path) {
            Ok(values) => {
                state.values = values;
                state.error = None;
            }
            Err(message) => state.error = Some(message),
        }
        drop(state);
        self.snapshot()
    }

    fn file_name(&self) -> String {
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "settings.json".into())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn read(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Value::Object(Map::new()));
        }
        Err(err) => return Err(err.to_string()),
    };
    match jsonc::parse(&text)? {
        value @ Value::Object(_) => Ok(value),
        _ => Err("the file must hold a JSON object ({ … })".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn updates_merge_and_null_resets() {
        let dir = tempfile::tempdir().unwrap();
        let file = SettingsFile::open(dir.path().join("settings.json"));
        assert_eq!(file.snapshot().values, json!({}));
        file.update(&json!({"editor.fontSize": 15, "workbench.theme": "dark"}))
            .unwrap();
        let snap = file
            .update(&json!({"editor.fontSize": null, "editor.tabSize": 2}))
            .unwrap();
        assert_eq!(
            snap.values,
            json!({"workbench.theme": "dark", "editor.tabSize": 2})
        );
        let reopened = SettingsFile::open(dir.path().join("settings.json"));
        assert_eq!(reopened.snapshot().values, snap.values);
    }

    #[test]
    fn a_damaged_file_keeps_the_last_good_values_and_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ \"editor.fontSize\": 14, // mine\n }").unwrap();
        let file = SettingsFile::open(&path);
        assert_eq!(file.snapshot().values, json!({"editor.fontSize": 14}));

        std::fs::write(&path, "{ \"editor.fontSize\": 14 \"oops\" }").unwrap();
        let snap = file.reload();
        assert!(snap.error.is_some());
        assert_eq!(snap.values, json!({"editor.fontSize": 14}));
        assert!(file.update(&json!({"editor.tabSize": 2})).is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ \"editor.fontSize\": 14 \"oops\" }"
        );
    }
}
