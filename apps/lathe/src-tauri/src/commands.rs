//! App-level commands the UI can call. Feature commands (files, terminals, search...) live in
//! their own modules; each one is a thin wrapper over lathe-core.

use serde::Serialize;
use tauri::{State, WebviewWindow, Wry};

use crate::state::AppState;
use crate::{Result, theme, window};

/// Called by the UI once it has painted, so the window never flashes.
#[tauri::command]
pub async fn app_ready(window: WebviewWindow<Wry>) -> Result<()> {
    window::mark_ready();
    if crate::guard::background_mode() {
        return Ok(());
    }
    window.show()?;
    window.set_focus()?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    app_version: &'static str,
    core_version: &'static str,
    webview_version: String,
    data_dir: String,
}

#[tauri::command]
pub async fn system_info(state: State<'_, AppState>) -> Result<SystemInfo> {
    Ok(SystemInfo {
        app_version: env!("CARGO_PKG_VERSION"),
        core_version: lathe_core::version(),
        webview_version: tauri::webview_version().unwrap_or_default(),
        data_dir: state.data_dir.display().to_string(),
    })
}

/// Keeps the native window background in step with the UI theme (it shows while resizing).
#[tauri::command]
pub async fn window_set_dark(window: WebviewWindow<Wry>, dark: bool) -> Result<()> {
    window.set_background_color(Some(theme::background(dark)))?;
    Ok(())
}

/// Where the HTML maximize button is, so Windows 11 Snap Layouts appear over it.
#[tauri::command]
pub async fn caption_maximize_rect(rect: crate::caption::ButtonRect) -> Result<()> {
    crate::caption::set_rect(rect);
    Ok(())
}

/// Opens a web or mail link in the default browser (the webview never navigates away).
#[tauri::command]
pub async fn open_link(url: String) -> Result<()> {
    crate::links::open(&url)
}

/// VS Code's folder of your settings, keybindings and snippets (`%APPDATA%\Code\User`), if it
/// has one. Debug builds can point it elsewhere with `LATHE_TEST_VSCODE_DIR` for tests.
#[tauri::command]
pub fn vscode_user_dir() -> Option<String> {
    let dir = crate::guard::test_value("LATHE_TEST_VSCODE_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            // A test run never looks at the real VS Code's folder.
            if crate::guard::test_data_dir().is_some() {
                return None;
            }
            std::env::var_os("APPDATA")
                .map(|a| std::path::PathBuf::from(a).join("Code").join("User"))
        })?;
    dir.is_dir().then(|| dir.display().to_string())
}
