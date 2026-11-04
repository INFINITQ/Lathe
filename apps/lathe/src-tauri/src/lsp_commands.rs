//! Language server sessions for the UI (`lathe_core::lsp`): start one, send it messages, stop
//! it. Each session's messages, log lines and exit stream to the UI over a Channel. Also the
//! tools folder, where Lathe keeps the servers it downloads.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use lathe_core::lsp::{Launch, LspEvent, LspSink, Server};
use lathe_core::tools::{self, ToolError};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::state::{AppState, absolute};
use crate::terminal_commands::resolve_program;

impl From<ToolError> for Error {
    fn from(err: ToolError) -> Self {
        Error::Coded {
            kind: err.kind(),
            message: err.to_string(),
        }
    }
}

#[derive(Default)]
pub struct LspSessions(Mutex<HashMap<String, Arc<Server>>>);

impl LspSessions {
    fn get(&self, id: &str) -> Option<Arc<Server>> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }
}

struct ChannelSink(Channel<LspEvent>);

impl LspSink for ChannelSink {
    fn send(&self, event: LspEvent) {
        let _ = self.0.send(event);
    }
}

#[derive(Serialize)]
pub struct Started {
    id: String,
    pid: u32,
    /// The program that actually runs (PATH resolved).
    program: String,
}

#[tauri::command]
pub async fn lsp_start(
    sessions: State<'_, LspSessions>,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    channel: Channel<LspEvent>,
) -> Result<Started> {
    let program = resolve_program(&program)?;
    let launch = Launch {
        program: program.clone(),
        args,
        cwd: absolute(&cwd)?,
        env,
    };
    let server = Server::start(&launch, Arc::new(ChannelSink(channel))).await?;
    let id = lathe_core::new_id();
    let pid = server.pid;
    sessions
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), server);
    Ok(Started {
        id,
        pid,
        program: program.display().to_string(),
    })
}

#[tauri::command]
pub async fn lsp_send(sessions: State<'_, LspSessions>, id: String, message: String) -> Result<()> {
    let server = sessions
        .get(&id)
        .ok_or_else(|| Error::NotFound("That language server isn't running.".into()))?;
    Ok(server.send(&message).await?)
}

#[tauri::command]
pub fn lsp_stop(sessions: State<'_, LspSessions>, id: String) {
    let server = sessions
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(server) = server {
        server.kill();
    }
}

/// `<data>\tools`, where downloaded servers live (`LATHE_TEST_TOOLS_DIR` in debug builds, so
/// live tests can keep their downloads between runs).
fn tools_root(state: &AppState) -> std::path::PathBuf {
    crate::guard::test_value("LATHE_TEST_TOOLS_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| state.data_dir.join("tools"))
}

#[tauri::command]
pub fn tools_dir(state: State<'_, AppState>) -> String {
    tools_root(&state).display().to_string()
}

/// Downloads an archive (HTTPS only), checks its SHA-256 and unpacks it into `tools\<name>`.
#[tauri::command]
pub async fn tools_install_archive(
    state: State<'_, AppState>,
    name: String,
    url: String,
    sha256: String,
) -> Result<String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    {
        return Err(Error::Invalid(format!("{name} isn't a valid tool name.")));
    }
    let dest = tools_root(&state).join(&name);
    tools::install_archive(&url, &sha256, &dest).await?;
    Ok(dest.display().to_string())
}
