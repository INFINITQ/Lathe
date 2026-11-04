//! Jupyter kernels for notebooks and `# %%` cells (`lathe_core::kernels`): finding their specs,
//! starting one, and talking to it. A kernel's messages stream to the UI over its Channel.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use lathe_core::kernels::{Kernel, KernelEvent, KernelLaunch, KernelSink, KernelSpec};
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::state::{AppState, absolute};
use crate::terminal_commands::resolve_program;

#[derive(Default)]
pub struct Kernels {
    open: Mutex<HashMap<String, Arc<Kernel>>>,
}

impl Kernels {
    fn get(&self, id: &str) -> Result<Arc<Kernel>> {
        self.open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound("That kernel has stopped.".into()))
    }
}

struct ChannelSink(Channel<KernelEvent>);

impl KernelSink for ChannelSink {
    fn send(&self, event: KernelEvent) {
        let _ = self.0.send(event);
    }
}

/// Kernelspecs from Jupyter's folders, plus each environment's (`prefixes` are sys.prefix).
#[tauri::command]
pub fn kernel_specs(prefixes: Vec<String>) -> Vec<KernelSpec> {
    let prefixes: Vec<PathBuf> = prefixes.into_iter().map(PathBuf::from).collect();
    lathe_core::kernels::specs(&prefixes)
}

#[derive(Serialize)]
pub struct Started {
    id: String,
    /// The kernel_info reply (language, version, banner).
    info: Value,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kernel_start(
    state: State<'_, AppState>,
    kernels: State<'_, Kernels>,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cwd: String,
    interrupt_mode: String,
    channel: Channel<KernelEvent>,
) -> Result<Started> {
    let mut argv = argv;
    let first = argv
        .first()
        .cloned()
        .ok_or_else(|| Error::Invalid("The kernel has no command to run.".into()))?;
    argv[0] = resolve_program(&first)?.display().to_string();
    let launch = KernelLaunch {
        argv,
        env,
        cwd: absolute(&cwd)?,
        interrupt_mode,
        runtime_dir: state.data_dir.join("kernels"),
    };
    let (kernel, info) = Kernel::start(launch, Arc::new(ChannelSink(channel))).await?;
    let id = lathe_core::new_id();
    kernels
        .open
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), kernel);
    Ok(Started { id, info })
}

#[tauri::command]
pub async fn kernel_execute(
    kernels: State<'_, Kernels>,
    id: String,
    msg_id: String,
    code: String,
    silent: bool,
    allow_stdin: bool,
) -> Result<()> {
    kernels
        .get(&id)?
        .execute(msg_id, code, silent, allow_stdin)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn kernel_complete(
    kernels: State<'_, Kernels>,
    id: String,
    code: String,
    cursor_pos: usize,
) -> Result<Value> {
    Ok(kernels.get(&id)?.complete(code, cursor_pos).await?)
}

#[tauri::command]
pub async fn kernel_inspect(
    kernels: State<'_, Kernels>,
    id: String,
    code: String,
    cursor_pos: usize,
) -> Result<Value> {
    Ok(kernels.get(&id)?.inspect(code, cursor_pos).await?)
}

#[tauri::command]
pub async fn kernel_input(kernels: State<'_, Kernels>, id: String, value: String) -> Result<()> {
    kernels.get(&id)?.input(value).await?;
    Ok(())
}

#[tauri::command]
pub async fn kernel_interrupt(kernels: State<'_, Kernels>, id: String) -> Result<()> {
    kernels.get(&id)?.interrupt().await?;
    Ok(())
}

/// Restarts on the same ports; returns the new kernel_info reply.
#[tauri::command]
pub async fn kernel_restart(kernels: State<'_, Kernels>, id: String) -> Result<Value> {
    Ok(kernels.get(&id)?.restart().await?)
}

#[tauri::command]
pub async fn kernel_shutdown(kernels: State<'_, Kernels>, id: String) -> Result<()> {
    let kernel = kernels
        .open
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    if let Some(kernel) = kernel {
        kernel.shutdown().await;
    }
    Ok(())
}
