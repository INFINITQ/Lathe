//! Debug adapters (DAP) use LSP's Content-Length framing over one of three transports: the
//! adapter's stdio (debugpy; that's `lsp::Server`), a TCP connection to the adapter's own
//! server (js-debug, which also wants a second connection per child session), or a TCP
//! connection the adapter makes back to Lathe (CodeLLDB's `--connect`). Adapter servers that
//! don't speak on stdio still get their output logged and their exit reported.

use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, oneshot};

use crate::lsp::{LspEvent, LspSink, frame, read_message};
use crate::proc;

/// A framed DAP connection over TCP.
pub struct TcpConnection {
    writer: Mutex<OwnedWriteHalf>,
    closed: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl TcpConnection {
    fn start(stream: TcpStream, sink: Arc<dyn LspSink>) -> Arc<TcpConnection> {
        let _ = stream.set_nodelay(true);
        let (read, write) = stream.into_split();
        let (close, closed) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let mut reader = BufReader::with_capacity(64 * 1024, read);
            let mut closed = closed;
            loop {
                tokio::select! {
                    message = read_message(&mut reader) => match message {
                        Ok(Some(data)) => sink.send(LspEvent::Message { data }),
                        Ok(None) => break,
                        Err(err) => {
                            sink.send(LspEvent::Log { line: format!("[lathe] the connection broke: {err}") });
                            break;
                        }
                    },
                    _ = &mut closed => break,
                }
            }
            sink.send(LspEvent::Exit { code: None });
        });
        Arc::new(TcpConnection {
            writer: Mutex::new(write),
            closed: std::sync::Mutex::new(Some(close)),
        })
    }

    /// Connects to an adapter's server, trying for up to `wait` while it starts.
    pub async fn connect(
        addr: SocketAddr,
        sink: Arc<dyn LspSink>,
        wait: Duration,
    ) -> io::Result<Arc<TcpConnection>> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match TcpStream::connect(addr).await {
                Ok(stream) => return Ok(Self::start(stream, sink)),
                Err(err) if tokio::time::Instant::now() >= deadline => return Err(err),
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    }

    pub async fn send(&self, json: &str) -> io::Result<()> {
        let mut writer = self.writer.lock().await;
        writer.write_all(&frame(json)).await?;
        writer.flush().await
    }

    pub fn close(&self) {
        if let Some(close) = self.closed.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = close.send(());
        }
    }
}

/// A port on 127.0.0.1 waiting for one adapter to connect (CodeLLDB's `--connect`).
pub struct Listener {
    pub port: u16,
    listener: TcpListener,
}

impl Listener {
    pub async fn bind() -> io::Result<Listener> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        Ok(Listener {
            port: listener.local_addr()?.port(),
            listener,
        })
    }

    /// Waits (up to `wait`) for the adapter to connect.
    pub async fn accept(
        self,
        sink: Arc<dyn LspSink>,
        wait: Duration,
    ) -> io::Result<Arc<TcpConnection>> {
        let (stream, _) = tokio::time::timeout(wait, self.listener.accept())
            .await
            .map_err(|_| {
                io::Error::new(io::ErrorKind::TimedOut, "the debug adapter didn't connect")
            })??;
        Ok(TcpConnection::start(stream, sink))
    }
}

/// An adapter server Lathe doesn't talk to on stdio (js-debug, CodeLLDB): its stdout and
/// stderr lines are logged, and its exit is reported.
pub struct LoggedProcess {
    stop: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    pub pid: u32,
}

impl LoggedProcess {
    pub fn spawn(
        program: &PathBuf,
        args: &[String],
        cwd: &PathBuf,
        env: &[(String, String)],
        sink: Arc<dyn LspSink>,
    ) -> io::Result<Arc<LoggedProcess>> {
        let mut command = proc::command(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in env {
            command.env(key, value);
        }
        let mut process = proc::spawn(&mut command)?;
        let pid = process.child.id().unwrap_or(0);
        for stream in [
            process
                .child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            process
                .child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let sink = sink.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink.send(LspEvent::Log { line });
                }
            });
        }
        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let code = tokio::select! {
                status = process.child.wait() => status.ok().and_then(|s| s.code()),
                _ = stopped => {
                    let _ = process.child.start_kill();
                    process.child.wait().await.ok().and_then(|s| s.code())
                }
            };
            drop(process);
            sink.send(LspEvent::Exit { code });
        });
        Ok(Arc::new(LoggedProcess {
            stop: std::sync::Mutex::new(Some(stop)),
            pid,
        }))
    }

    pub fn kill(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stop.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Collect(std::sync::Mutex<Vec<LspEvent>>);

    impl LspSink for Collect {
        fn send(&self, event: LspEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    async fn until(sink: &Collect, what: impl Fn(&[LspEvent]) -> bool) {
        for _ in 0..200 {
            if what(&sink.0.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("timed out: {:?}", sink.0.lock().unwrap());
    }

    #[tokio::test]
    async fn an_adapter_connects_back_and_messages_go_both_ways() {
        let listener = Listener::bind().await.unwrap();
        let port = listener.port;
        let ours = Arc::new(Collect::default());
        // The "adapter": connects to our port, says hello, echoes what it gets.
        let adapter = tokio::spawn(async move {
            let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let theirs = Arc::new(Collect::default());
            let conn = TcpConnection::start(stream, theirs.clone());
            conn.send("{\"type\":\"event\",\"event\":\"hello\"}")
                .await
                .unwrap();
            until(&theirs, |e| {
                e.iter().any(|x| matches!(x, LspEvent::Message { .. }))
            })
            .await;
            conn.close();
        });
        let conn = listener
            .accept(ours.clone(), Duration::from_secs(5))
            .await
            .unwrap();
        until(&ours, |e| {
            e.iter()
                .any(|x| matches!(x, LspEvent::Message { data } if data.contains("hello")))
        })
        .await;
        conn.send("{\"type\":\"request\",\"command\":\"initialize\"}")
            .await
            .unwrap();
        adapter.await.unwrap();
        until(&ours, |e| {
            e.iter().any(|x| matches!(x, LspEvent::Exit { .. }))
        })
        .await;
    }

    #[tokio::test]
    async fn logs_a_server_and_reports_its_exit() {
        let sink = Arc::new(Collect::default());
        let process = LoggedProcess::spawn(
            &PathBuf::from("cmd"),
            &[
                "/d".into(),
                "/c".into(),
                "echo Debug server listening at 127.0.0.1:4711".into(),
            ],
            &std::env::temp_dir(),
            &[],
            sink.clone(),
        )
        .unwrap();
        assert!(process.pid > 0);
        until(&sink, |e| {
            e.iter().any(|x| matches!(x, LspEvent::Exit { .. }))
        })
        .await;
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(
            |e| matches!(e, LspEvent::Log { line } if line.contains("listening at 127.0.0.1:4711"))
        ));
    }
}
