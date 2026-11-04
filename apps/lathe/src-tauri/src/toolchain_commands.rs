//! Toolchains for the Run button: what's installed, Microsoft's C++ developer environment,
//! compile steps (run to completion, output captured), winget installs, and whether you trust
//! a folder's code.

use std::time::Duration;

use lathe_core::run::{self, Captured};
use lathe_core::toolchains::{self, Toolchain};
use tauri::State;

use crate::Result;
use crate::state::{AppState, absolute};
use crate::terminal_commands::resolve_program;

#[tauri::command]
pub async fn toolchains_detect(state: State<'_, AppState>) -> Result<Vec<Toolchain>> {
    Ok(toolchains::detect(&state.data_dir).await)
}

/// The variables `VsDevCmd.bat` sets (cached), or null without Visual Studio's C++ tools.
#[tauri::command]
pub async fn toolchain_msvc_env(
    state: State<'_, AppState>,
) -> Result<Option<Vec<(String, String)>>> {
    Ok(toolchains::msvc_environment(&state.data_dir).await?)
}

/// Re-reads PATH from the registry, after an install.
#[tauri::command]
pub async fn path_refresh() -> Result<()> {
    toolchains::refresh_path();
    Ok(())
}

#[tauri::command]
pub async fn program_which(name: String) -> Result<Option<String>> {
    Ok(run::which(&name).map(|p| p.display().to_string()))
}

/// Runs a program to completion (a compile step) and returns what it printed.
#[tauri::command]
pub async fn run_capture(
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    timeout_ms: Option<u64>,
) -> Result<Captured> {
    let program = resolve_program(&program)?;
    let cwd = absolute(&cwd)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    Ok(run::capture(&program, &args, &cwd, &env, timeout).await?)
}

/// The winget arguments that install `package` (shown to you before anything runs).
#[tauri::command]
pub async fn winget_args(package: String) -> Result<Vec<String>> {
    Ok(toolchains::winget_args(&package))
}

#[tauri::command]
pub async fn trust_get(state: State<'_, AppState>, folder: String) -> Result<bool> {
    Ok(state.session.is_trusted(&folder))
}

#[tauri::command]
pub async fn trust_set(state: State<'_, AppState>, folder: String, trusted: bool) -> Result<()> {
    Ok(state.session.set_trusted(&folder, trusted)?)
}
