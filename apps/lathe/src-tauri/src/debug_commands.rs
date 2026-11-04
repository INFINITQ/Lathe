//! Debug adapter connections for the UI (`lathe_core::dap`): an adapter on stdio, a TCP
//! connection to an adapter's server (one per session; js-debug wants one per child session
//! too), or a connection an adapter makes back to Lathe, plus adapter servers whose output is
//! only logged. Messages and events stream to the UI over a Channel per connection.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lathe_core::dap::{Listener, LoggedProcess, TcpConnection};
use lathe_core::lsp::{Launch, LspEvent, LspSink, Server};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::state::absolute;
use crate::terminal_commands::resolve_program;

enum Connection {
    Stdio(Arc<Server>),
    Tcp(Arc<TcpConnection>),
    Process(Arc<LoggedProcess>),
}

#[derive(Default)]
pub struct DebugConnections {
    open: Mutex<HashMap<String, Connection>>,
    listening: tauri::async_runtime::Mutex<HashMap<String, Listener>>,
}

impl DebugConnections {
    fn insert(&self, id: &str, connection: Connection) {
        self.open
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_owned(), connection);
    }
}

struct ChannelSink(Channel<LspEvent>);

impl LspSink for ChannelSink {
    fn send(&self, event: LspEvent) {
        let _ = self.0.send(event);
    }
}

#[derive(Serialize)]
pub struct Spawned {
    id: String,
    pid: u32,
    program: String,
}

/// Starts an adapter. With `stdio`, Lathe speaks DAP on its stdin and stdout; otherwise its
/// output is only logged (a server Lathe connects to, or one that connects back).
#[tauri::command]
pub async fn dap_spawn(
    connections: State<'_, DebugConnections>,
    program: String,
    args: Vec<String>,
    cwd: String,
    env: Vec<(String, String)>,
    stdio: bool,
    channel: Channel<LspEvent>,
) -> Result<Spawned> {
    let program = resolve_program(&program)?;
    let cwd = absolute(&cwd)?;
    let sink = Arc::new(ChannelSink(channel));
    let id = lathe_core::new_id();
    let pid = if stdio {
        let launch = Launch {
            program: program.clone(),
            args,
            cwd,
            env,
        };
        let server = Server::start(&launch, sink).await?;
        let pid = server.pid;
        connections.insert(&id, Connection::Stdio(server));
        pid
    } else {
        let process = LoggedProcess::spawn(&program, &args, &cwd, &env, sink)?;
        let pid = process.pid;
        connections.insert(&id, Connection::Process(process));
        pid
    };
    Ok(Spawned {
        id,
        pid,
        program: program.display().to_string(),
    })
}

/// Connects to an adapter's server on 127.0.0.1 (waiting while it starts up).
#[tauri::command]
pub async fn dap_connect(
    connections: State<'_, DebugConnections>,
    port: u16,
    channel: Channel<LspEvent>,
) -> Result<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let connection = TcpConnection::connect(
        addr,
        Arc::new(ChannelSink(channel)),
        Duration::from_secs(10),
    )
    .await?;
    let id = lathe_core::new_id();
    connections.insert(&id, Connection::Tcp(connection));
    Ok(id)
}

#[derive(Serialize)]
pub struct Listening {
    id: String,
    port: u16,
}

/// Opens a port for an adapter to connect back to (CodeLLDB's `--connect`).
#[tauri::command]
pub async fn dap_listen(connections: State<'_, DebugConnections>) -> Result<Listening> {
    let listener = Listener::bind().await?;
    let port = listener.port;
    let id = lathe_core::new_id();
    connections
        .listening
        .lock()
        .await
        .insert(id.clone(), listener);
    Ok(Listening { id, port })
}

/// Waits for the adapter to connect to a port from `dap_listen`.
#[tauri::command]
pub async fn dap_accept(
    connections: State<'_, DebugConnections>,
    id: String,
    channel: Channel<LspEvent>,
) -> Result<()> {
    let listener = connections
        .listening
        .lock()
        .await
        .remove(&id)
        .ok_or_else(|| Error::NotFound("That port isn't open any more.".into()))?;
    let connection = listener
        .accept(Arc::new(ChannelSink(channel)), Duration::from_secs(20))
        .await?;
    connections.insert(&id, Connection::Tcp(connection));
    Ok(())
}

#[tauri::command]
pub async fn dap_send(
    connections: State<'_, DebugConnections>,
    id: String,
    message: String,
) -> Result<()> {
    enum Target {
        Stdio(Arc<Server>),
        Tcp(Arc<TcpConnection>),
    }
    let target = match connections
        .open
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        Some(Connection::Stdio(server)) => Target::Stdio(server.clone()),
        Some(Connection::Tcp(conn)) => Target::Tcp(conn.clone()),
        Some(Connection::Process(_)) => {
            return Err(Error::Invalid(
                "That adapter doesn't take messages on stdin.".into(),
            ));
        }
        None => return Err(Error::NotFound("That debug session has ended.".into())),
    };
    match target {
        Target::Stdio(server) => server.send(&message).await?,
        Target::Tcp(conn) => conn.send(&message).await?,
    }
    Ok(())
}

/// Closes a connection, or stops an adapter process (and everything it started).
#[tauri::command]
pub fn dap_close(connections: State<'_, DebugConnections>, id: String) {
    let connection = connections
        .open
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
    match connection {
        Some(Connection::Stdio(server)) => server.kill(),
        Some(Connection::Tcp(conn)) => conn.close(),
        Some(Connection::Process(process)) => process.kill(),
        None => {}
    }
}
