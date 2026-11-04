//! Downloads into Lathe's own tools folder (language servers, debug adapters). Windows' own
//! `curl.exe` fetches over HTTPS only, the file must match a pinned SHA-256 before anything
//! else happens, and Windows' `tar.exe` unpacks archives into a fresh folder that replaces the
//! old one only once it's complete.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::proc;

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("The download failed: {0}")]
    Download(String),
    #[error("The download didn't match its expected checksum, so it was deleted.")]
    Checksum,
    #[error("Couldn't unpack the download: {0}")]
    Unpack(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl ToolError {
    pub fn kind(&self) -> &'static str {
        match self {
            ToolError::Download(_) => "download",
            ToolError::Checksum => "checksum",
            ToolError::Unpack(_) => "unpack",
            ToolError::Io(_) => "io",
        }
    }
}

fn system32(program: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    Path::new(&root).join("System32").join(program)
}

/// The SHA-256 of a file, as lower-case hex.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

async fn run(program: &Path, args: &[&std::ffi::OsStr], timeout: Duration) -> Result<(), String> {
    let mut command = proc::command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let process = proc::spawn(&mut command).map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(timeout, process.child.wait_with_output())
        .await
        .map_err(|_| "it took too long".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            format!("exit code {:?}", output.status.code())
        } else {
            message
        })
    }
}

/// Downloads `url` to `file` with curl (HTTPS only, redirects allowed).
pub async fn download(url: &str, file: &Path) -> Result<(), ToolError> {
    if !url.starts_with("https://") {
        return Err(ToolError::Download(
            "only HTTPS downloads are allowed".into(),
        ));
    }
    run(
        &system32("curl.exe"),
        &[
            "--fail".as_ref(),
            "--location".as_ref(),
            "--silent".as_ref(),
            "--show-error".as_ref(),
            "--proto".as_ref(),
            "=https".as_ref(),
            "--proto-redir".as_ref(),
            "=https".as_ref(),
            "--retry".as_ref(),
            "2".as_ref(),
            "--output".as_ref(),
            file.as_os_str(),
            url.as_ref(),
        ],
        Duration::from_secs(15 * 60),
    )
    .await
    .map_err(ToolError::Download)
}

/// Checks `file` against `sha256`, then unpacks it (zip or tar) into `dest`, replacing what was
/// there. A file that doesn't match is deleted.
pub async fn verify_and_unpack(file: &Path, sha256: &str, dest: &Path) -> Result<(), ToolError> {
    let actual = sha256_file(file)?;
    if !actual.eq_ignore_ascii_case(sha256.trim()) {
        let _ = std::fs::remove_file(file);
        return Err(ToolError::Checksum);
    }
    let parent = dest
        .parent()
        .ok_or_else(|| ToolError::Unpack("no parent folder".into()))?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(
        ".{}.unpacking",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    run(
        &system32("tar.exe"),
        &[
            "-xf".as_ref(),
            file.as_os_str(),
            "-C".as_ref(),
            staging.as_os_str(),
        ],
        Duration::from_secs(10 * 60),
    )
    .await
    .map_err(ToolError::Unpack)?;
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    std::fs::rename(&staging, dest)?;
    Ok(())
}

/// Unpacks a zip or tar archive into `dest` (which must exist), with Windows' own tar.exe.
pub async fn unpack(file: &Path, dest: &Path) -> Result<(), String> {
    run(
        &system32("tar.exe"),
        &[
            "-xf".as_ref(),
            file.as_os_str(),
            "-C".as_ref(),
            dest.as_os_str(),
        ],
        Duration::from_secs(10 * 60),
    )
    .await
}

/// Downloads an archive, checks it and unpacks it into `dest`.
pub async fn install_archive(url: &str, sha256: &str, dest: &Path) -> Result<(), ToolError> {
    let parent = dest
        .parent()
        .ok_or_else(|| ToolError::Unpack("no parent folder".into()))?;
    std::fs::create_dir_all(parent)?;
    let name = url
        .rsplit('/')
        .next()
        .unwrap_or("download")
        .replace(['?', '&', '='], "_");
    let file = parent.join(format!(".{name}.download"));
    let result = async {
        download(url, &file).await?;
        verify_and_unpack(&file, sha256, dest).await
    }
    .await;
    let _ = std::fs::remove_file(&file);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::disallowed_methods)]
    fn zip_of(dir: &Path, name: &str, content: &str) -> PathBuf {
        let source = dir.join("source");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::write(source.join("bin").join(name), content).unwrap();
        let archive = dir.join("tool.zip");
        let status = std::process::Command::new(system32("tar.exe"))
            .args(["-a", "-c", "-f"])
            .arg(&archive)
            .arg("-C")
            .arg(&source)
            .arg("bin")
            .status()
            .unwrap();
        assert!(status.success());
        archive
    }

    #[tokio::test]
    async fn unpacks_a_matching_archive_and_replaces_the_old_folder() {
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_of(dir.path(), "tool.txt", "v2");
        let sha = sha256_file(&archive).unwrap();
        let dest = dir.path().join("tools").join("tool");
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("old.txt"), "v1").unwrap();
        verify_and_unpack(&archive, &sha.to_uppercase(), &dest)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("bin").join("tool.txt")).unwrap(),
            "v2"
        );
        assert!(!dest.join("old.txt").exists());
    }

    #[tokio::test]
    async fn refuses_and_deletes_a_mismatching_file() {
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_of(dir.path(), "tool.txt", "evil");
        let dest = dir.path().join("tools").join("tool");
        let err = verify_and_unpack(&archive, &"0".repeat(64), &dest)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Checksum));
        assert!(!archive.exists());
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn only_downloads_over_https() {
        let dir = tempfile::tempdir().unwrap();
        let err = download("http://example.com/x.zip", &dir.path().join("x"))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Download(_)));
    }
}
