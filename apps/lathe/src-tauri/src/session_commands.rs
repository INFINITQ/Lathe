//! Settings (yours and the folder's), the session (what was open), unsaved-buffer backups,
//! recent folders and the window title.

use lathe_core::settings::Snapshot;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State, WebviewWindow, Wry};

use crate::state::AppState;
use crate::{Error, Result, window};

/// Sent with both snapshots after any settings change, so every part of the UI stays in sync.
pub const SETTINGS_EVENT: &str = "lathe://settings";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    User,
    Workspace,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AllSettings {
    user: Snapshot,
    workspace: Option<Snapshot>,
}

fn all(state: &AppState) -> AllSettings {
    AllSettings {
        user: state.user_settings.snapshot(),
        workspace: state.folder().map(|f| f.settings.snapshot()),
    }
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<AllSettings> {
    Ok(all(&state))
}

/// Applies a JSON merge patch (`null` resets a setting) to your settings or the folder's.
#[tauri::command]
pub async fn settings_set(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
    scope: Scope,
    patch: Value,
) -> Result<AllSettings> {
    match scope {
        Scope::User => {
            state.user_settings.update(&patch)?;
        }
        Scope::Workspace => {
            state.require_folder()?.settings.update(&patch)?;
        }
    }
    let next = all(&state);
    let _ = app.emit_to(window::MAIN, SETTINGS_EVENT, &next);
    Ok(next)
}

/// Re-reads both settings files (after you saved one in the editor).
#[tauri::command]
pub async fn settings_reload(
    app: AppHandle<Wry>,
    state: State<'_, AppState>,
) -> Result<AllSettings> {
    state.user_settings.reload();
    if let Some(folder) = state.folder() {
        folder.settings.reload();
    }
    let next = all(&state);
    let _ = app.emit_to(window::MAIN, SETTINGS_EVENT, &next);
    Ok(next)
}

#[tauri::command]
pub async fn session_save(state: State<'_, AppState>, session: Value) -> Result<()> {
    Ok(state.session.save(&session)?)
}

#[tauri::command]
pub async fn buffer_save(state: State<'_, AppState>, id: String, text: String) -> Result<()> {
    Ok(state.session.save_buffer(&id, &text)?)
}

#[tauri::command]
pub async fn buffer_load(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    Ok(state.session.load_buffer(&id))
}

#[tauri::command]
pub async fn buffer_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    state.session.remove_buffer(&id);
    Ok(())
}

/// Deletes backups of unsaved editors that aren't open any more.
#[tauri::command]
pub async fn buffers_prune(state: State<'_, AppState>, keep: Vec<String>) -> Result<()> {
    state.session.prune_buffers(&keep);
    Ok(())
}

#[tauri::command]
pub async fn recent_folders(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(state.session.recent_folders())
}

#[tauri::command]
pub async fn recent_remove(state: State<'_, AppState>, path: String) -> Result<Vec<String>> {
    Ok(state.session.remove_recent_folder(&path)?)
}

/// The title Windows shows on the taskbar and in Alt+Tab.
#[tauri::command]
pub async fn window_set_title(window: WebviewWindow<Wry>, title: String) -> Result<()> {
    if title.len() > 300 {
        return Err(Error::Invalid("That title is too long.".into()));
    }
    window.set_title(&title)?;
    Ok(())
}
