//! The open folder: opening it (watcher and file index), quick open, and its settings.

use std::sync::Arc;

use lathe_core::settings::{SettingsFile, Snapshot};
use lathe_core::workspace::{Change, FileMatch, WatchSink, Workspace};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::state::{AppState, OpenFolder, absolute};
use crate::{Error, Result};

/// The watcher's changes go to the UI through a Channel.
struct ChannelSink(Channel<Vec<Change>>);

impl WatchSink for ChannelSink {
    fn changes(&self, changes: Vec<Change>) {
        // A reloaded page just misses changes; it lists folders afresh when it opens them.
        let _ = self.0.send(changes);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFolder {
    root: String,
    name: String,
    settings: Snapshot,
    recent: Vec<String>,
}

/// Opens a folder: starts watching it and indexing its files, loads its settings, and adds it
/// to the recent folders. Changes on disk arrive on `events`.
#[tauri::command]
pub async fn workspace_open(
    state: State<'_, AppState>,
    path: String,
    events: Channel<Vec<Change>>,
) -> Result<OpenedFolder> {
    let path = absolute(&path)?;
    if !path.is_dir() {
        return Err(Error::NotFound(format!(
            "{} isn't a folder (it may have been moved or deleted).",
            path.display()
        )));
    }
    let workspace = Workspace::open(&path, Arc::new(ChannelSink(events)))?;
    let root = workspace.root().to_path_buf();
    let settings = Arc::new(SettingsFile::open(
        root.join(".lathe").join("settings.json"),
    ));
    let snapshot = settings.snapshot();
    state.set_folder(Some(OpenFolder {
        workspace,
        settings,
    }));
    let root_text = root.display().to_string();
    let recent = state.session.add_recent_folder(&root_text)?;
    Ok(OpenedFolder {
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_text.clone()),
        root: root_text,
        settings: snapshot,
        recent,
    })
}

/// Closes the open folder (stops its watcher).
#[tauri::command]
pub async fn workspace_close(state: State<'_, AppState>) -> Result<()> {
    state.set_folder(None);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundFiles {
    matches: Vec<FileMatch>,
    /// False while the folder is still being indexed (results may be incomplete).
    complete: bool,
    total: usize,
}

/// Quick open: fuzzy-matches `query` against the open folder's files.
#[tauri::command]
pub async fn workspace_find_files(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<FoundFiles> {
    let folder = state.require_folder()?;
    let limit = limit.unwrap_or(60).min(500);
    tauri::async_runtime::spawn_blocking(move || FoundFiles {
        matches: folder.workspace.find_files(&query, limit),
        complete: folder.workspace.is_indexed(),
        total: folder.workspace.file_count(),
    })
    .await
    .map_err(|err| Error::Invalid(err.to_string()))
}
