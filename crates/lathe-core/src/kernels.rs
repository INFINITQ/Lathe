//! Jupyter kernels (docs/spikes/jupyter.md has the measurements behind each step): finding
//! kernelspecs, starting a kernel the way jupyter_client does on Windows (the interrupt event and
//! the parent handle ipykernel waits on, inside a Job Object), its ZeroMQ sockets, and every
//! message it sends passed on as JSON for the UI to route by its parent's id. Restarting
//! relaunches on the same ports and builds a new client, because zmq.rs doesn't reconnect.

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use jupyter_protocol::{
    CompleteRequest, ConnectionInfo, ExecuteRequest, InputReply, InspectRequest, InterruptRequest,
    JupyterMessage, JupyterMessageContent, KernelInfoRequest, ReplyStatus, ShutdownRequest,
    Transport,
};
use jupyter_zmq_client as zmq;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::{Mutex, oneshot, watch};
use tokio::task::JoinHandle;

use crate::proc;

/// A kernel described by a kernel.json file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelSpec {
    /// The folder's name, lower-cased, as Jupyter names kernels.
    pub name: String,
    pub display_name: String,
    pub language: String,
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    /// "signal" (the interrupt event) or "message" (an interrupt_request).
    pub interrupt_mode: String,
    /// The folder holding kernel.json.
    pub dir: PathBuf,
}

#[derive(Deserialize)]
struct SpecFile {
    argv: Vec<String>,
    display_name: Option<String>,
    language: Option<String>,
    interrupt_mode: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

/// Jupyter's data folders in jupyter_core's order: JUPYTER_PATH, then each environment's
/// share\jupyter (`prefixes` are their sys.prefix), the user's, and the machine's only when
/// JUPYTER_USE_PROGRAMDATA is set.
pub fn data_dirs(prefixes: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(paths) = std::env::var_os("JUPYTER_PATH") {
        dirs.extend(std::env::split_paths(&paths).filter(|p| !p.as_os_str().is_empty()));
    }
    for prefix in prefixes {
        dirs.push(prefix.join("share").join("jupyter"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        dirs.push(appdata.join("jupyter"));
        dirs.push(appdata.join("Python").join("share").join("jupyter"));
    }
    if std::env::var_os("JUPYTER_USE_PROGRAMDATA").is_some()
        && let Some(data) = std::env::var_os("PROGRAMDATA")
    {
        dirs.push(PathBuf::from(data).join("jupyter"));
    }
    dirs
}

/// Every kernelspec in those folders; the first one with a name wins.
pub fn specs(prefixes: &[PathBuf]) -> Vec<KernelSpec> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for dir in data_dirs(prefixes) {
        let Ok(entries) = std::fs::read_dir(dir.join("kernels")) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let folder = entry.path();
            let Some(name) = folder
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_lowercase)
            else {
                continue;
            };
            let Ok(text) = std::fs::read_to_string(folder.join("kernel.json")) else {
                continue;
            };
            let Ok(spec) = serde_json::from_str::<SpecFile>(&text) else {
                continue;
            };
            if spec.argv.is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            found.push(KernelSpec {
                display_name: spec.display_name.unwrap_or_else(|| name.clone()),
                language: spec.language.unwrap_or_default(),
                argv: spec.argv,
                env: spec.env,
                interrupt_mode: spec.interrupt_mode.unwrap_or_else(|| "signal".into()),
                dir: folder,
                name,
            });
        }
    }
    found
}

/// What a kernel sends Lathe's UI.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KernelEvent {
    /// A message from the kernel (iopub, shell, stdin or control).
    #[serde(rename_all = "camelCase")]
    Message {
        channel: &'static str,
        msg_type: String,
        msg_id: String,
        parent_id: Option<String>,
        content: Value,
        metadata: Value,
    },
    /// A line the kernel process wrote to its own stdout or stderr: C-level printing, child
    /// processes, crashes. Python's own output arrives on iopub instead.
    Log { line: String },
    /// The kernel process ended on its own (not by a restart or shutdown).
    Exit { code: Option<i32> },
}

pub trait KernelSink: Send + Sync {
    fn send(&self, event: KernelEvent);
}

/// How to start a kernel: its argv (with `{connection_file}`), extra environment, folder.
#[derive(Debug, Clone)]
pub struct KernelLaunch {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub interrupt_mode: String,
    /// Where the connection file goes.
    pub runtime_dir: PathBuf,
}

#[derive(Clone, Copy)]
enum Channel {
    Shell,
    Control,
    Stdin,
}

type Waiters = Arc<StdMutex<HashMap<String, oneshot::Sender<JupyterMessage>>>>;

struct Running {
    job: Arc<proc::Job>,
    interrupt: Option<win::OwnedHandle>,
    shell: zmq::DealerSendConnection,
    control: zmq::DealerSendConnection,
    stdin: zmq::DealerSendConnection,
    readers: Vec<JoinHandle<()>>,
    exited: watch::Receiver<bool>,
}

impl Drop for Running {
    fn drop(&mut self) {
        for reader in &self.readers {
            reader.abort();
        }
        self.job.kill();
    }
}

/// A running kernel.
pub struct Kernel {
    launch: KernelLaunch,
    info: ConnectionInfo,
    connection_file: PathBuf,
    sink: Arc<dyn KernelSink>,
    running: Mutex<Option<Running>>,
    /// Bumped by restart and shutdown, so the old process's exit isn't reported as a crash.
    generation: Arc<AtomicU64>,
    waiters: Waiters,
    /// The last input_request, which `input` answers.
    input_request: Arc<StdMutex<Option<JupyterMessage>>>,
}

fn other(err: impl std::fmt::Display) -> io::Error {
    io::Error::other(err.to_string())
}

/// A random HMAC key, as hex (two v4 UUIDs: 244 random bits).
fn random_key() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn pipe_lines(stream: impl AsyncRead + Unpin + Send + 'static, sink: Arc<dyn KernelSink>) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => sink.send(KernelEvent::Log {
                    line: String::from_utf8_lossy(&line).trim_end().to_string(),
                }),
            }
        }
    });
}

impl Kernel {
    /// Starts a kernel and waits until it answers kernel_info. Returns it with that reply.
    pub async fn start(
        launch: KernelLaunch,
        sink: Arc<dyn KernelSink>,
    ) -> io::Result<(Arc<Kernel>, Value)> {
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let (ports, listeners) = zmq::peek_ports_with_listeners(ip, 5).await.map_err(other)?;
        let info = ConnectionInfo {
            transport: Transport::TCP,
            ip: ip.to_string(),
            shell_port: ports[0],
            iopub_port: ports[1],
            stdin_port: ports[2],
            control_port: ports[3],
            hb_port: ports[4],
            signature_scheme: "hmac-sha256".into(),
            key: random_key(),
            kernel_name: None,
        };
        std::fs::create_dir_all(&launch.runtime_dir)?;
        let connection_file = launch
            .runtime_dir
            .join(format!("kernel-{}.json", &info.key[..12]));
        std::fs::write(&connection_file, serde_json::to_vec_pretty(&info)?)?;
        let kernel = Arc::new(Kernel {
            launch,
            info,
            connection_file,
            sink,
            running: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            waiters: Arc::default(),
            input_request: Arc::default(),
        });
        let running = match kernel.spawn(listeners).await {
            Ok(running) => running,
            Err(err) => {
                let _ = std::fs::remove_file(&kernel.connection_file);
                return Err(err);
            }
        };
        *kernel.running.lock().await = Some(running);
        let info = kernel.ready().await?;
        Ok((kernel, info))
    }

    /// kernel_info, which also tells us it's ready; then a throwaway completion, since the
    /// first one is slow (Jedi warms up).
    async fn ready(self: &Arc<Self>) -> io::Result<Value> {
        let reply = self
            .request(
                Channel::Shell,
                KernelInfoRequest {}.into(),
                Duration::from_secs(60),
            )
            .await?;
        let warm = self.clone();
        tokio::spawn(async move {
            let _ = warm.complete(String::new(), 0).await;
        });
        Ok(serde_json::to_value(&reply.content).unwrap_or(Value::Null))
    }

    async fn spawn<T>(&self, listeners: Vec<T>) -> io::Result<Running> {
        let interrupt = if self.launch.interrupt_mode == "message" {
            None
        } else {
            Some(win::interrupt_event()?)
        };
        let parent = win::parent_handle()?;
        let file = self.connection_file.display().to_string();
        let mut argv = self
            .launch
            .argv
            .iter()
            .map(|arg| arg.replace("{connection_file}", &file));
        let program = argv.next().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "The kernel has no argv.")
        })?;
        let mut command = proc::command(&program);
        command
            .args(argv)
            .current_dir(&self.launch.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // Silences debugpy's warning about frozen modules (as Jupyter does).
            .env("PYDEVD_DISABLE_FILE_VALIDATION", "1")
            .env("PYTHONIOENCODING", "utf-8")
            // A handle, despite the name: ipykernel exits when it's signalled (Lathe ended).
            .env("JPY_PARENT_PID", parent.env_value());
        if let Some(event) = &interrupt {
            command.env("JPY_INTERRUPT_EVENT", event.env_value());
        }
        for (key, value) in &self.launch.env {
            command.env(key, value);
        }
        let process = proc::spawn(&mut command);
        // The kernel binds the reserved ports first thing; let go of them now.
        drop(listeners);
        // Keep the event out of every later child (terminals, servers, the next kernel).
        if let Some(event) = &interrupt {
            event.set_inheritable(false)?;
        }
        drop(parent);
        let proc::Process { mut child, job } = process?;
        let job = Arc::new(job);
        if let Some(out) = child.stdout.take() {
            pipe_lines(out, self.sink.clone());
        }
        if let Some(err) = child.stderr.take() {
            pipe_lines(err, self.sink.clone());
        }
        let (exit_tx, exited) = watch::channel(false);
        let generation = self.generation.load(Ordering::SeqCst);
        let current = self.generation.clone();
        let sink = self.sink.clone();
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            let _ = exit_tx.send(true);
            if current.load(Ordering::SeqCst) == generation {
                sink.send(KernelEvent::Exit { code });
            }
        });

        let mut died = exited.clone();
        let connected = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(60), self.connect()) => match result {
                Ok(connected) => connected,
                Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "The kernel didn't start within a minute.")),
            },
            _ = died.wait_for(|exited| *exited) => Err(io::Error::other("The kernel stopped while starting.")),
        };
        let (shell, control, stdin, readers) = match connected {
            Ok(parts) => parts,
            Err(err) => {
                job.kill();
                return Err(err);
            }
        };
        Ok(Running {
            job,
            interrupt,
            shell,
            control,
            stdin,
            readers,
            exited,
        })
    }

    #[allow(clippy::type_complexity)]
    async fn connect(
        &self,
    ) -> io::Result<(
        zmq::DealerSendConnection,
        zmq::DealerSendConnection,
        zmq::DealerSendConnection,
        Vec<JoinHandle<()>>,
    )> {
        let session = uuid::Uuid::new_v4().simple().to_string();
        // iopub first; only after its welcome can nothing published for us be lost.
        let mut iopub = zmq::create_client_iopub_connection(&self.info, "", &session)
            .await
            .map_err(other)?;
        let _ = zmq::wait_for_iopub_welcome(&mut iopub, Duration::from_secs(2)).await;
        // shell and stdin share an identity, or input_request never reaches us.
        let identity = zmq::peer_identity_for_session(&session).map_err(other)?;
        let shell = zmq::create_client_shell_connection_with_identity(
            &self.info,
            &session,
            identity.clone(),
        )
        .await
        .map_err(other)?;
        let stdin =
            zmq::create_client_stdin_connection_with_identity(&self.info, &session, identity)
                .await
                .map_err(other)?;
        let control = zmq::create_client_control_connection(&self.info, &session)
            .await
            .map_err(other)?;
        let (shell_tx, shell_rx) = shell.split();
        let (stdin_tx, stdin_rx) = stdin.split();
        let (control_tx, control_rx) = control.split();
        let readers = vec![
            self.reader(iopub, "iopub"),
            self.reader(shell_rx, "shell"),
            self.reader(stdin_rx, "stdin"),
            self.reader(control_rx, "control"),
        ];
        Ok((shell_tx, control_tx, stdin_tx, readers))
    }

    fn reader<S>(&self, mut connection: zmq::Connection<S>, channel: &'static str) -> JoinHandle<()>
    where
        S: zeromq::SocketRecv + Send + 'static,
    {
        let sink = self.sink.clone();
        let waiters = self.waiters.clone();
        let input = self.input_request.clone();
        tokio::spawn(async move {
            loop {
                let message = match connection.read().await {
                    Ok(message) => message,
                    // The socket is gone (the kernel stopped, or we dropped it).
                    Err(zmq::RuntimeError::ZmqError(_)) => break,
                    // A bad signature or content we can't read: skip that message.
                    Err(_) => continue,
                };
                let parent = message.parent_header.as_ref().map(|p| p.msg_id.clone());
                if matches!(channel, "shell" | "control") {
                    let waiter = parent.as_ref().and_then(|id| {
                        waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(id)
                    });
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(message);
                        continue;
                    }
                }
                if matches!(message.content, JupyterMessageContent::InputRequest(_)) {
                    *input.lock().unwrap_or_else(|e| e.into_inner()) = Some(message.clone());
                }
                sink.send(KernelEvent::Message {
                    channel,
                    msg_type: message.header.msg_type.clone(),
                    msg_id: message.header.msg_id.clone(),
                    parent_id: parent,
                    content: serde_json::to_value(&message.content).unwrap_or(Value::Null),
                    metadata: message.metadata.clone(),
                });
            }
        })
    }

    async fn send(&self, channel: Channel, message: JupyterMessage) -> io::Result<()> {
        let mut running = self.running.lock().await;
        let running = running
            .as_mut()
            .ok_or_else(|| io::Error::other("The kernel isn't running."))?;
        match channel {
            Channel::Shell => running.shell.send(message).await,
            Channel::Control => running.control.send(message).await,
            Channel::Stdin => running.stdin.send(message).await,
        }
        .map_err(other)
    }

    async fn request(
        &self,
        channel: Channel,
        message: JupyterMessage,
        timeout: Duration,
    ) -> io::Result<JupyterMessage> {
        let id = message.header.msg_id.clone();
        let (tx, rx) = oneshot::channel();
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), tx);
        let forget = || {
            self.waiters
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
        };
        if let Err(err) = self.send(channel, message).await {
            forget();
            return Err(err);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            _ => {
                forget();
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "The kernel didn't answer.",
                ))
            }
        }
    }

    /// Runs code. `msg_id` is chosen by the caller, so it can route the first outputs, which
    /// can arrive before this returns.
    pub async fn execute(
        &self,
        msg_id: String,
        code: String,
        silent: bool,
        allow_stdin: bool,
    ) -> io::Result<()> {
        let mut message: JupyterMessage = ExecuteRequest {
            code,
            silent,
            store_history: !silent,
            user_expressions: None,
            allow_stdin,
            stop_on_error: true,
        }
        .into();
        if !msg_id.is_empty() {
            message.header.msg_id = msg_id;
        }
        self.send(Channel::Shell, message).await
    }

    /// complete_reply's content. `cursor_pos` counts code points, as the protocol does.
    pub async fn complete(&self, code: String, cursor_pos: usize) -> io::Result<Value> {
        let reply = self
            .request(
                Channel::Shell,
                CompleteRequest { code, cursor_pos }.into(),
                Duration::from_secs(10),
            )
            .await?;
        Ok(serde_json::to_value(&reply.content).unwrap_or(Value::Null))
    }

    /// inspect_reply's content (documentation for what's at the cursor).
    pub async fn inspect(&self, code: String, cursor_pos: usize) -> io::Result<Value> {
        let reply = self
            .request(
                Channel::Shell,
                InspectRequest {
                    code,
                    cursor_pos,
                    detail_level: Some(0),
                }
                .into(),
                Duration::from_secs(10),
            )
            .await?;
        Ok(serde_json::to_value(&reply.content).unwrap_or(Value::Null))
    }

    /// Answers the kernel's last input_request (`input()` in Python).
    pub async fn input(&self, value: String) -> io::Result<()> {
        let request = self
            .input_request
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .ok_or_else(|| io::Error::other("The kernel isn't waiting for input."))?;
        let reply = InputReply {
            value,
            status: ReplyStatus::Ok,
            error: None,
        }
        .as_child_of(&request);
        self.send(Channel::Stdin, reply).await
    }

    /// Stops what's running: the interrupt event, or an interrupt_request for kernels that
    /// ask for one.
    pub async fn interrupt(&self) -> io::Result<()> {
        if self.launch.interrupt_mode == "message" {
            return self
                .send(Channel::Control, InterruptRequest {}.into())
                .await;
        }
        let running = self.running.lock().await;
        if let Some(event) = running.as_ref().and_then(|r| r.interrupt.as_ref()) {
            win::set_event(event)?;
        }
        Ok(())
    }

    /// Stops the process: asks first, then ends its Job Object.
    async fn stop(&self, running: &mut Option<Running>, restart: bool) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut old) = running.take() {
            let _ = old.control.send(ShutdownRequest { restart }.into()).await;
            let mut exited = old.exited.clone();
            let _ = tokio::time::timeout(Duration::from_secs(3), exited.wait_for(|e| *e)).await;
            drop(old);
        }
    }

    /// Restarts the kernel on the same ports; returns the new kernel_info reply.
    pub async fn restart(self: &Arc<Self>) -> io::Result<Value> {
        {
            let mut running = self.running.lock().await;
            self.stop(&mut running, true).await;
            *running = Some(self.spawn(Vec::<()>::new()).await?);
        }
        self.ready().await
    }

    pub async fn shutdown(&self) {
        let mut running = self.running.lock().await;
        self.stop(&mut running, false).await;
        let _ = std::fs::remove_file(&self.connection_file);
    }
}

/// The Win32 handles ipykernel expects on Windows.
mod win {
    use std::io;

    use windows::Win32::Foundation::{
        CloseHandle, DUPLICATE_HANDLE_OPTIONS, DuplicateHandle, HANDLE, HANDLE_FLAG_INHERIT,
        HANDLE_FLAGS, SetHandleInformation,
    };
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, PROCESS_SYNCHRONIZE, SetEvent,
    };
    use windows::core::PCWSTR;

    use crate::proc::os_error;

    pub struct OwnedHandle(HANDLE);

    // SAFETY: a handle is a process-wide reference to a kernel object; any thread may use it.
    unsafe impl Send for OwnedHandle {}
    // SAFETY: the calls made on it are thread-safe.
    unsafe impl Sync for OwnedHandle {}

    impl OwnedHandle {
        /// An inherited handle keeps its value in the child, which reads it as a decimal.
        pub fn env_value(&self) -> String {
            (self.0.0 as usize).to_string()
        }

        pub fn set_inheritable(&self, inheritable: bool) -> io::Result<()> {
            let flags = if inheritable {
                HANDLE_FLAG_INHERIT
            } else {
                HANDLE_FLAGS(0)
            };
            // SAFETY: the handle is ours and open.
            unsafe { SetHandleInformation(self.0, HANDLE_FLAG_INHERIT.0, flags) }.map_err(os_error)
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the handle is ours.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    /// The interrupt event, as jupyter_client makes it: unnamed, auto-reset, inheritable.
    pub fn interrupt_event() -> io::Result<OwnedHandle> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        // SAFETY: `attributes` outlives the call.
        unsafe { CreateEventW(Some(&attributes), false, false, PCWSTR::null()) }
            .map(OwnedHandle)
            .map_err(os_error)
    }

    /// An inheritable handle to Lathe for JPY_PARENT_PID. SYNCHRONIZE is all ipykernel needs to
    /// wait on it, so the kernel's code gets no other access to Lathe.
    pub fn parent_handle() -> io::Result<OwnedHandle> {
        let mut handle = HANDLE::default();
        // SAFETY: the current-process pseudo handle duplicated into a real one.
        unsafe {
            let me = GetCurrentProcess();
            DuplicateHandle(
                me,
                me,
                me,
                &mut handle,
                PROCESS_SYNCHRONIZE.0,
                true,
                DUPLICATE_HANDLE_OPTIONS(0),
            )
        }
        .map_err(os_error)?;
        Ok(OwnedHandle(handle))
    }

    pub fn set_event(event: &OwnedHandle) -> io::Result<()> {
        // SAFETY: the handle is an event we created.
        unsafe { SetEvent(event.0) }.map_err(os_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jupyter_protocol::StreamContent;
    use zmq::{CannedResponse, TestKernel, TestKernelConfig};

    #[derive(Default)]
    struct Collect(StdMutex<Vec<KernelEvent>>);

    impl KernelSink for Collect {
        fn send(&self, event: KernelEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    impl Collect {
        fn messages(&self) -> Vec<(String, Option<String>, Value)> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| match e {
                    KernelEvent::Message {
                        msg_type,
                        parent_id,
                        content,
                        ..
                    } => Some((msg_type.clone(), parent_id.clone(), content.clone())),
                    _ => None,
                })
                .collect()
        }
    }

    #[test]
    fn finds_kernelspecs_and_lets_the_first_name_win() {
        let dir = tempfile::tempdir().unwrap();
        for (prefix, name, display) in [("a", "Fake", "Fake A"), ("b", "fake", "Fake B")] {
            let folder = dir
                .path()
                .join(prefix)
                .join("share")
                .join("jupyter")
                .join("kernels")
                .join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(
                folder.join("kernel.json"),
                format!(
                    r#"{{"argv": ["python", "-m", "ipykernel_launcher", "-f", "{{connection_file}}"], "display_name": "{display}", "language": "python"}}"#
                ),
            )
            .unwrap();
        }
        let found = specs(&[dir.path().join("a"), dir.path().join("b")]);
        let fake: Vec<_> = found.iter().filter(|s| s.name == "fake").collect();
        assert_eq!(fake.len(), 1);
        assert_eq!(fake[0].display_name, "Fake A");
        assert_eq!(fake[0].interrupt_mode, "signal");
        assert_eq!(fake[0].argv[4], "{connection_file}");
    }

    /// A stand-in process plays the kernel's part for the Job Object, while the test kernel
    /// serves the protocol in-process on the ports from the connection file.
    #[tokio::test]
    async fn runs_code_and_routes_its_output() {
        let dir = tempfile::tempdir().unwrap();
        let runtime_dir = dir.path().to_path_buf();
        let config = TestKernelConfig::default().with_response(
            "print(1+1)",
            CannedResponse {
                outputs: vec![StreamContent::stdout("2\n").into()],
            },
        );
        let serve = runtime_dir.clone();
        let server = tokio::spawn(async move {
            for _ in 0..200 {
                let file = std::fs::read_dir(&serve)
                    .ok()
                    .and_then(|mut entries| entries.next())
                    .and_then(|e| e.ok())
                    .map(|e| e.path());
                if let Some(file) = file {
                    return TestKernel::start_from_file(&file, config).await.unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            panic!("no connection file");
        });
        let sink = Arc::new(Collect::default());
        let launch = KernelLaunch {
            argv: vec![
                "cmd".into(),
                "/d".into(),
                "/c".into(),
                "ping -n 60 127.0.0.1 >nul".into(),
            ],
            env: vec![],
            cwd: std::env::temp_dir(),
            interrupt_mode: "signal".into(),
            runtime_dir,
        };
        let (kernel, info) = Kernel::start(launch, sink.clone()).await.unwrap();
        assert_eq!(info["status"], "ok");
        kernel
            .execute("run-1".into(), "print(1+1)".into(), false, true)
            .await
            .unwrap();
        for _ in 0..200 {
            let idle = sink.messages().iter().any(|(t, p, c)| {
                t == "status" && p.as_deref() == Some("run-1") && c["execution_state"] == "idle"
            });
            if idle {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let messages = sink.messages();
        let ours: Vec<_> = messages
            .iter()
            .filter(|(_, p, _)| p.as_deref() == Some("run-1"))
            .collect();
        assert!(
            ours.iter()
                .any(|(t, _, c)| t == "stream" && c["text"] == "2\n"),
            "{ours:?}"
        );
        assert!(
            ours.iter()
                .any(|(t, _, c)| t == "execute_reply" && c["status"] == "ok")
        );
        assert!(
            ours.iter()
                .any(|(t, _, c)| t == "execute_input" && c["execution_count"] == 1)
        );
        let completion = kernel.complete("pri".into(), 3).await.unwrap();
        assert_eq!(completion["status"], "ok");
        kernel.shutdown().await;
        server.await.unwrap().abort();
    }
}
