//! What the shell keeps between commands.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use lathe_core::session::SessionStore;
use lathe_core::settings::SettingsFile;
use lathe_core::workspace::Workspace;

use crate::{Error, Result};

pub struct AppState {
    pub data_dir: PathBuf,
    /// Your own settings (`settings.json` in the data folder).
    pub user_settings: Arc<SettingsFile>,
    pub session: SessionStore,
    open: Mutex<Option<OpenFolder>>,
}

/// The open folder and its own settings (`.lathe/settings.json`).
#[derive(Clone)]
pub struct OpenFolder {
    pub workspace: Arc<Workspace>,
    pub settings: Arc<SettingsFile>,
}

impl AppState {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            user_settings: Arc::new(SettingsFile::open(data_dir.join("settings.json"))),
            session: SessionStore::new(data_dir),
            open: Mutex::new(None),
        }
    }

    pub fn folder(&self) -> Option<OpenFolder> {
        self.lock().clone()
    }

    /// The open folder, or an error the UI can show.
    pub fn require_folder(&self) -> Result<OpenFolder> {
        self.folder()
            .ok_or_else(|| Error::Invalid("Open a folder first.".into()))
    }

    pub fn set_folder(&self, folder: Option<OpenFolder>) {
        let old = std::mem::replace(&mut *self.lock(), folder);
        if let Some(old) = old {
            old.workspace.close();
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<OpenFolder>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// An absolute path from the UI. Relative paths are refused: they would depend on Lathe's own
/// working folder.
pub fn absolute(path: &str) -> Result<PathBuf> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(Error::Invalid(format!(
            "{} isn't a full path.",
            path.display()
        )));
    }
    Ok(path)
}
