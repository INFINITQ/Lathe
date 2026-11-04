//! Running a program to completion and capturing what it printed: compile steps before the
//! Run button starts a program, and tool probes (`python --version`). Interactive runs go to a
//! terminal instead (`terminal::Launch::program`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::{proc, shell};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    /// None when it was stopped (timeout) or killed by a signal.
    pub code: Option<i64>,
    /// stdout and stderr together, in the order they arrived.
    pub output: String,
    pub elapsed_ms: u64,
    pub timed_out: bool,
}

/// Runs `program` with `args` in `cwd` (with `env` added) and waits for it, at most `timeout`.
/// The whole process tree is stopped when time runs out.
pub async fn capture(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    timeout: Duration,
) -> std::io::Result<Captured> {
    let started = Instant::now();
    let mut command = proc::command(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in env {
        command.env(name, value);
    }
    let mut process = proc::spawn(&mut command)?;
    let output = Arc::new(Mutex::new(Vec::<u8>::new()));
    let readers = [
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
    .map(|mut pipe| {
        let output = output.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                output
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .extend_from_slice(&buf[..n]);
            }
        })
    })
    .collect::<Vec<_>>();
    let waited = tokio::time::timeout(timeout, process.child.wait()).await;
    let (code, timed_out) = match waited {
        Ok(status) => (status?.code().map(i64::from), false),
        Err(_) => {
            process.job.kill();
            let _ = process.child.wait().await;
            (None, true)
        }
    };
    for reader in readers {
        let _ = reader.await;
    }
    let bytes = std::mem::take(&mut *output.lock().unwrap_or_else(|p| p.into_inner()));
    Ok(Captured {
        code,
        output: shell::decode(&bytes),
        elapsed_ms: started.elapsed().as_millis() as u64,
        timed_out,
    })
}

/// Finds a program on PATH the way Windows does (PATHEXT), skipping the Microsoft Store's
/// app-execution aliases (`python.exe` there only opens the Store).
pub fn which(name: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.is_absolute() {
        return direct.is_file().then(|| direct.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if Path::new(name).extension().is_some() {
        vec![String::new()]
    } else {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    };
    for dir in std::env::split_paths(&path) {
        if dir
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("\\windowsapps")
        {
            continue;
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_output_and_exit_codes() {
        let cmd = which("cmd").expect("cmd.exe is on PATH");
        let dir = std::env::temp_dir();
        let args = ["/d", "/c", "echo hello& exit 3"].map(String::from);
        let ran = capture(&cmd, &args, &dir, &[], Duration::from_secs(10))
            .await
            .unwrap();
        assert!(ran.output.contains("hello"), "{ran:?}");
        assert_eq!(ran.code, Some(3));
        assert!(!ran.timed_out);
    }

    #[tokio::test]
    async fn stops_programs_that_take_too_long() {
        let cmd = which("cmd").unwrap();
        let args = ["/d", "/c", "ping -n 30 127.0.0.1 >nul"].map(String::from);
        let ran = capture(
            &cmd,
            &args,
            &std::env::temp_dir(),
            &[],
            Duration::from_millis(300),
        )
        .await
        .unwrap();
        assert!(ran.timed_out);
        assert!(ran.elapsed_ms < 5000);
    }

    #[test]
    fn which_finds_programs_and_skips_missing_ones() {
        assert!(which("cmd").is_some());
        assert!(which("definitely-not-a-real-program-xyz").is_none());
    }
}
