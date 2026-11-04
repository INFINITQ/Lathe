//! Terminals: shells for the terminal panel, and programs started by the Run button. They run in
//! Rust (`lathe_core::terminal`) and stream to the UI over a channel; a reloaded UI attaches
//! again and gets what they showed so far.

use std::path::PathBuf;
use std::sync::Arc;

use lathe_core::run::which;
use lathe_core::terminal::profiles::{self, Profile};
use lathe_core::terminal::{Launch, TerminalEvent, TerminalInfo, TerminalSink, Terminals};
use tauri::State;
use tauri::ipc::Channel;

use crate::state::absolute;
use crate::{Error, Result};

struct ChannelSink(Channel<TerminalEvent>);

impl TerminalSink for ChannelSink {
    fn send(&self, event: TerminalEvent) {
        // A closed page just misses the event; it gets the scrollback when it attaches again.
        let _ = self.0.send(event);
    }
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// A program by full path, or by name on PATH ("python", "node").
pub fn resolve_program(program: &str) -> Result<PathBuf> {
    let path = PathBuf::from(program);
    if path.is_absolute() {
        return if path.is_file() {
            Ok(path)
        } else {
            Err(Error::NotFound(format!("{program} isn't there.")))
        };
    }
    which(program)
        .ok_or_else(|| Error::NotFound(format!("{program} isn't installed (or isn't on PATH).")))
}

async fn open(
    terminals: Arc<Terminals>,
    launch: Launch,
    cwd: PathBuf,
    tag: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo> {
    if !cwd.is_dir() {
        return Err(Error::Invalid(format!(
            "{} isn't there anymore.",
            cwd.display()
        )));
    }
    tauri::async_runtime::spawn_blocking(move || terminals.open(&launch, &cwd, tag, cols, rows))
        .await
        .map_err(|err| Error::Invalid(err.to_string()))?
        .map_err(Error::from)
}

/// The shells this PC has.
#[tauri::command]
pub async fn terminal_profiles() -> Result<Vec<Profile>> {
    tauri::async_runtime::spawn_blocking(profiles::profiles)
        .await
        .map_err(|err| Error::Invalid(err.to_string()))
}

/// Starts a shell (PowerShell unless another profile is given) in `cwd`, or your home folder.
#[tauri::command]
pub async fn terminal_open(
    terminals: State<'_, Arc<Terminals>>,
    profile: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    tag: Option<String>,
) -> Result<TerminalInfo> {
    let id = profile.unwrap_or_else(|| "powershell".into());
    let launch = profiles::launch(&id)
        .ok_or_else(|| Error::NotFound(format!("That shell ({id}) isn't installed.")))?;
    let cwd = match cwd {
        Some(cwd) => absolute(&cwd)?,
        None => home(),
    };
    open(terminals.inner().clone(), launch, cwd, tag, cols, rows).await
}

/// Runs a program in a new terminal (the Run button): its output streams like a shell's and you
/// can type into it (`input()`, `std::cin`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn terminal_run(
    terminals: State<'_, Arc<Terminals>>,
    title: String,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
    tag: Option<String>,
) -> Result<TerminalInfo> {
    let program = resolve_program(&program)?;
    let launch = Launch::program(&title, program, args, env);
    open(
        terminals.inner().clone(),
        launch,
        absolute(&cwd)?,
        tag,
        cols,
        rows,
    )
    .await
}

/// Streams a terminal's output to the page, starting with what it showed so far.
#[tauri::command]
pub async fn terminal_attach(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    channel: Channel<TerminalEvent>,
) -> Result<()> {
    Ok(terminals.attach(&id, Arc::new(ChannelSink(channel)))?)
}

#[tauri::command]
pub async fn terminal_write(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    data: String,
) -> Result<()> {
    Ok(terminals.write(&id, &data)?)
}

#[tauri::command]
pub async fn terminal_resize(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    Ok(terminals.resize(&id, cols, rows)?)
}

/// Ends the terminal's program and everything started in it.
#[tauri::command]
pub async fn terminal_close(terminals: State<'_, Arc<Terminals>>, id: String) -> Result<()> {
    terminals.close(&id);
    Ok(())
}

#[tauri::command]
pub async fn terminals_list(terminals: State<'_, Arc<Terminals>>) -> Result<Vec<TerminalInfo>> {
    Ok(terminals.list())
}
