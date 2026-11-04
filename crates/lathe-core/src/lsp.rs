//! Language servers: child processes that speak JSON-RPC over stdio with `Content-Length`
//! framing. Rust only frames messages and owns the process (its job object, its logs and its
//! exit); the UI's LSP client handles the protocol itself.

use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{Mutex, oneshot};

use crate::proc;

/// How to start a server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LspEvent {
    /// One JSON-RPC message from the server (headers removed).
    Message { data: String },
    /// A line the server wrote to stderr (its log).
    Log { line: String },
    /// The server exited.
    Exit { code: Option<i32> },
}

pub trait LspSink: Send + Sync {
    fn send(&self, event: LspEvent);
}

/// A running language server.
pub struct Server {
    stdin: Mutex<ChildStdin>,
    stop: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    pub pid: u32,
}

/// Messages bigger than this are refused (a broken server, not a real message).
const MAX_MESSAGE: usize = 256 * 1024 * 1024;

/// Reads one framed message; `None` when the stream ends.
pub async fn read_message<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<String>> {
    let mut length: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            let value: usize = value
                .trim()
                .parse()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "bad Content-Length"))?;
            if value > MAX_MESSAGE {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "message too large",
                ));
            }
            length = Some(value);
        }
    }
    let mut body = vec![0; length.unwrap_or(0)];
    reader.read_exact(&mut body).await?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "message isn't UTF-8"))
}

/// The bytes of one framed message.
pub fn frame(json: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", json.len()).into_bytes();
    out.extend_from_slice(json.as_bytes());
    out
}

impl Server {
    /// Starts a server; its messages, log lines and exit go to `sink`.
    pub async fn start(launch: &Launch, sink: Arc<dyn LspSink>) -> io::Result<Arc<Server>> {
        let mut command = proc::command(&launch.program);
        command
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in &launch.env {
            command.env(key, value);
        }
        let mut process = proc::spawn(&mut command)?;
        let pid = process.child.id().unwrap_or(0);
        let stdin = process
            .child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("no stdin"))?;
        let stdout = process
            .child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no stdout"))?;
        let stderr = process
            .child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("no stderr"))?;

        let messages = sink.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            loop {
                match read_message(&mut reader).await {
                    Ok(Some(data)) => messages.send(LspEvent::Message { data }),
                    Ok(None) => break,
                    Err(err) => {
                        messages.send(LspEvent::Log {
                            line: format!("[lathe] stopped reading the server's output: {err}"),
                        });
                        break;
                    }
                }
            }
        });

        let logs = sink.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logs.send(LspEvent::Log { line });
            }
        });

        let (stop, stopped) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let code = tokio::select! {
                status = process.child.wait() => status.ok().and_then(|s| s.code()),
                _ = stopped => {
                    let _ = process.child.start_kill();
                    process.child.wait().await.ok().and_then(|s| s.code())
                }
            };
            // The job object goes with `process`, taking any helpers the server started.
            drop(process);
            sink.send(LspEvent::Exit { code });
        });

        Ok(Arc::new(Server {
            stdin: Mutex::new(stdin),
            stop: std::sync::Mutex::new(Some(stop)),
            pid,
        }))
    }

    /// Sends one JSON-RPC message to the server.
    pub async fn send(&self, json: &str) -> io::Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(&frame(json)).await?;
        stdin.flush().await
    }

    /// Kills the server (and everything it started).
    pub fn kill(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stop.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_framed_messages_with_any_header_case_and_extra_headers() {
        let input = b"Content-Length: 7\r\n\r\n{\"a\":1}content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        let mut reader = BufReader::new(&input[..]);
        assert_eq!(
            read_message(&mut reader).await.unwrap().as_deref(),
            Some("{\"a\":1}")
        );
        assert_eq!(
            read_message(&mut reader).await.unwrap().as_deref(),
            Some("{}")
        );
        assert_eq!(read_message(&mut reader).await.unwrap(), None);
    }

    #[tokio::test]
    async fn frames_count_bytes_not_characters() {
        let framed = frame("{\"text\":\"é😀\"}");
        let mut reader = BufReader::new(&framed[..]);
        assert_eq!(
            read_message(&mut reader).await.unwrap().as_deref(),
            Some("{\"text\":\"é😀\"}")
        );
    }

    #[tokio::test]
    async fn refuses_absurd_lengths() {
        let input = b"Content-Length: 999999999999\r\n\r\n";
        let mut reader = BufReader::new(&input[..]);
        assert!(read_message(&mut reader).await.is_err());
    }

    #[derive(Default)]
    struct Collect(std::sync::Mutex<Vec<LspEvent>>);

    impl LspSink for Collect {
        fn send(&self, event: LspEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    /// A real child: PowerShell echoes back each framed message it reads.
    #[tokio::test]
    async fn talks_to_a_real_process_and_reports_its_exit() {
        let script = r#"
$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin)
$header = $reader.ReadLine(); [void]$reader.ReadLine()
$length = [int]($header -replace 'Content-Length: ','')
$buffer = New-Object char[] $length
[void]$reader.Read($buffer, 0, $length)
$body = -join $buffer
[Console]::Error.WriteLine('got it')
$out = "Content-Length: $($body.Length)`r`n`r`n$body"
[Console]::Out.Write($out); [Console]::Out.Flush()
"#;
        let sink = Arc::new(Collect::default());
        let launch = Launch {
            program: "powershell".into(),
            args: vec!["-NoProfile".into(), "-Command".into(), script.into()],
            cwd: std::env::temp_dir(),
            env: Vec::new(),
        };
        let server = Server::start(&launch, sink.clone()).await.unwrap();
        server
            .send("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}")
            .await
            .unwrap();
        for _ in 0..200 {
            if sink
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, LspEvent::Exit { .. }))
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, LspEvent::Message { data } if data == "{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}")), "{events:?}");
        assert!(
            events
                .iter()
                .any(|e| matches!(e, LspEvent::Log { line } if line == "got it"))
        );
        assert!(matches!(
            events.last(),
            Some(LspEvent::Exit { code: Some(0) })
        ));
    }
}
