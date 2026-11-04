//! Search and replace across the open folder (`lathe_core::search`). Results stream to the UI
//! over a Channel; starting a search stops the one before it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use lathe_core::search::{self, Edit, Query, SearchError, SearchEvent, SearchSink};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::state::{AppState, absolute};

impl From<SearchError> for Error {
    fn from(err: SearchError) -> Self {
        Error::Coded {
            kind: err.kind(),
            message: err.to_string(),
        }
    }
}

/// Each running search's stop flag, by slot ("view" for the Search view, "symbols" for
/// quick open's workspace symbols), so one never cancels the other.
#[derive(Default)]
pub struct Searches(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Searches {
    fn replace(&self, slot: &str, next: Option<Arc<AtomicBool>>) {
        let mut running = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let previous = match next {
            Some(next) => running.insert(slot.to_owned(), next),
            None => running.remove(slot),
        };
        if let Some(previous) = previous {
            previous.store(true, Ordering::Relaxed);
        }
    }
}

struct ChannelSink(Channel<SearchEvent>);

impl SearchSink for ChannelSink {
    fn send(&self, event: SearchEvent) {
        let _ = self.0.send(event);
    }
}

/// Searches the open folder. `unsaved` is `[path, text]` for open files with unsaved changes.
#[tauri::command]
pub async fn search_start(
    state: State<'_, AppState>,
    searches: State<'_, Searches>,
    query: Query,
    unsaved: Vec<(String, String)>,
    slot: Option<String>,
    channel: Channel<SearchEvent>,
) -> Result<()> {
    let root = state.require_folder()?.workspace.root().to_path_buf();
    let cancel = Arc::new(AtomicBool::new(false));
    searches.replace(slot.as_deref().unwrap_or("view"), Some(cancel.clone()));
    let unsaved: HashMap<PathBuf, String> = unsaved
        .into_iter()
        .map(|(path, text)| (PathBuf::from(path), text))
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        search::search(
            &root,
            &query,
            &unsaved,
            Arc::new(ChannelSink(channel)),
            cancel,
        );
    });
    Ok(())
}

#[tauri::command]
pub fn search_cancel(searches: State<'_, Searches>, slot: Option<String>) {
    searches.replace(slot.as_deref().unwrap_or("view"), None);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Replaced {
    path: String,
    count: usize,
    error: Option<ReplaceError>,
}

#[derive(Serialize)]
pub struct ReplaceError {
    kind: &'static str,
    message: String,
}

/// Replaces every match in files that aren't open in the editor.
#[tauri::command]
pub async fn search_replace_files(
    query: Query,
    replacement: String,
    paths: Vec<String>,
) -> Result<Vec<Replaced>> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let outcome = absolute(&path)
                    .map_err(|err| ReplaceError {
                        kind: err.kind(),
                        message: err.to_string(),
                    })
                    .and_then(|file| {
                        search::replace_in_file(&file, &query, &replacement, None).map_err(|err| {
                            ReplaceError {
                                kind: err.kind(),
                                message: err.to_string(),
                            }
                        })
                    });
                match outcome {
                    Ok(count) => Replaced {
                        path,
                        count,
                        error: None,
                    },
                    Err(error) => Replaced {
                        path,
                        count: 0,
                        error: Some(error),
                    },
                }
            })
            .collect()
    })
    .await
    .map_err(|err| Error::Invalid(err.to_string()))
}

/// Replaces the one match at `line` (1-based) and `column` (UTF-16) in a file on disk.
#[tauri::command]
pub async fn search_replace_at(
    query: Query,
    replacement: String,
    path: String,
    line: u32,
    column: u32,
) -> Result<usize> {
    let file = absolute(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        search::replace_in_file(&file, &query, &replacement, Some((line, column)))
    })
    .await
    .map_err(|err| Error::Invalid(err.to_string()))?
    .map_err(Error::from)
}

/// The edits that replace matches in an open document's text (all, or the one at `at`).
#[tauri::command]
pub fn search_edits(
    query: Query,
    replacement: String,
    text: String,
    at: Option<u32>,
) -> Result<Vec<Edit>> {
    Ok(search::edits(&query, &replacement, &text, at)?)
}
