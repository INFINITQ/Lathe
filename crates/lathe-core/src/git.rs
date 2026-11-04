//! Git, through the `git` command line (Git for Windows): status in porcelain v2, file contents
//! at a revision, staging (whole files, or exact index contents for single hunks), commits,
//! branches, stashes, history and blame. Every call runs in a job object with a timeout;
//! sign-in is left to Git Credential Manager, which shows its own window, and terminal
//! prompts are turned off so nothing ever waits on a console nobody can see.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::files::TextFormat;
use crate::proc;
use crate::text::TextFile;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("Git isn't installed (or isn't on PATH).")]
    NotInstalled,
    #[error("{0} isn't inside a Git repository.")]
    NotARepo(String),
    #[error("{0}")]
    Failed(String),
    #[error("Git took too long and was stopped.")]
    Timeout,
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl GitError {
    pub fn kind(&self) -> &'static str {
        match self {
            GitError::NotInstalled => "notInstalled",
            GitError::NotARepo(_) => "notARepo",
            GitError::Failed(_) => "gitFailed",
            GitError::Timeout => "timeout",
            GitError::Io(_) => "io",
        }
    }
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// Where git.exe is.
pub fn git_program() -> Result<PathBuf, GitError> {
    crate::run::which("git").ok_or(GitError::NotInstalled)
}

/// Runs git in `cwd`; `input` goes to its stdin. Fails with git's own message on a non-zero exit.
pub async fn run(
    cwd: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<Output, GitError> {
    let program = git_program()?;
    let mut command = proc::command(&program);
    command
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = proc::spawn(&mut command)?;
    if let Some(input) = input
        && let Some(mut stdin) = process.child.stdin.take()
    {
        stdin.write_all(input).await?;
        drop(stdin);
    }
    let output = tokio::time::timeout(timeout, process.child.wait_with_output())
        .await
        .map_err(|_| GitError::Timeout)??;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let message = if stderr.is_empty() {
            format!(
                "git {} failed (exit code {:?}).",
                args.first().unwrap_or(&""),
                output.status.code()
            )
        } else {
            stderr
        };
        return Err(GitError::Failed(message));
    }
    Ok(Output {
        stdout: output.stdout,
        stderr,
    })
}

const QUICK: Duration = Duration::from_secs(30);
const NETWORK: Duration = Duration::from_secs(15 * 60);

/// The repository's top folder, if `dir` is inside one.
pub async fn toplevel(dir: &Path) -> Result<Option<PathBuf>, GitError> {
    match run(dir, &["rev-parse", "--show-toplevel"], None, QUICK).await {
        Ok(out) => {
            let path = String::from_utf8_lossy(&out.stdout)
                .trim()
                .replace('/', "\\");
            Ok(Some(PathBuf::from(path)))
        }
        Err(GitError::Failed(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

/// One changed file. Paths are absolute; `index` and `worktree` are porcelain letters
/// (`M`, `A`, `D`, `R`, `C`, `T`, `U`, or `.` for unchanged; `?` for untracked).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub orig_path: Option<String>,
    pub index: char,
    pub worktree: char,
    pub conflict: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub root: String,
    /// The branch, or None when HEAD is detached.
    pub branch: Option<String>,
    /// The commit HEAD points at; None before the first commit.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<FileStatus>,
}

fn absolute(root: &Path, relative: &str) -> String {
    root.join(relative.replace('/', "\\")).display().to_string()
}

/// Parses `git status --porcelain=v2 --branch -z`.
pub fn parse_status(root: &Path, raw: &[u8]) -> RepoStatus {
    let text = String::from_utf8_lossy(raw);
    let mut status = RepoStatus {
        root: root.display().to_string(),
        ..RepoStatus::default()
    };
    let mut entries = text.split('\0').peekable();
    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                "branch.upstream" => status.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            status.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            status.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = entry.as_bytes()[0];
        let letters = |xy: &str| {
            let mut chars = xy.chars();
            (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'))
        };
        match kind {
            b'1' => {
                let fields: Vec<&str> = entry.splitn(9, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(8)) {
                    let (index, worktree) = letters(xy);
                    status.files.push(FileStatus {
                        path: absolute(root, path),
                        orig_path: None,
                        index,
                        worktree,
                        conflict: false,
                    });
                }
            }
            b'2' => {
                let fields: Vec<&str> = entry.splitn(10, ' ').collect();
                let orig = entries.next().unwrap_or("");
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(9)) {
                    let (index, worktree) = letters(xy);
                    status.files.push(FileStatus {
                        path: absolute(root, path),
                        orig_path: Some(absolute(root, orig)),
                        index,
                        worktree,
                        conflict: false,
                    });
                }
            }
            b'u' => {
                let fields: Vec<&str> = entry.splitn(11, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1), fields.get(10)) {
                    let (index, worktree) = letters(xy);
                    status.files.push(FileStatus {
                        path: absolute(root, path),
                        orig_path: None,
                        index,
                        worktree,
                        conflict: true,
                    });
                }
            }
            b'?' => status.files.push(FileStatus {
                path: absolute(root, &entry[2..]),
                orig_path: None,
                index: '?',
                worktree: '?',
                conflict: false,
            }),
            _ => {}
        }
    }
    status
}

pub async fn status(root: &Path) -> Result<RepoStatus, GitError> {
    let out = run(
        root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        None,
        QUICK,
    )
    .await?;
    Ok(parse_status(root, &out.stdout))
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// A file's text at `rev` ("HEAD", a commit, or "" for the index), with `\n` line endings,
/// and the format to write it back in. None when the file doesn't exist there.
#[derive(Debug, Clone, Serialize)]
pub struct Blob {
    pub text: String,
    pub format: TextFormat,
}

pub async fn show(root: &Path, rev: &str, path: &Path) -> Result<Option<Blob>, GitError> {
    let spec = format!("{rev}:{}", relative(root, path));
    match run(root, &["show", &spec], None, QUICK).await {
        Ok(out) => {
            let Ok(file) = TextFile::decode(&out.stdout) else {
                return Ok(None);
            };
            let format = TextFormat {
                encoding: file.encoding_name().into(),
                bom: file.bom(),
                crlf: file.crlf(),
            };
            Ok(Some(Blob {
                text: file.text,
                format,
            }))
        }
        // "does not exist in", "exists on disk, but not in": it's new.
        Err(GitError::Failed(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

pub async fn stage(root: &Path, paths: &[PathBuf]) -> Result<(), GitError> {
    let mut args = vec!["add", "-A", "--"];
    let relative: Vec<String> = paths.iter().map(|p| relative(root, p)).collect();
    args.extend(relative.iter().map(String::as_str));
    run(root, &args, None, QUICK).await.map(|_| ())
}

pub async fn unstage(root: &Path, paths: &[PathBuf], has_head: bool) -> Result<(), GitError> {
    let relative: Vec<String> = paths.iter().map(|p| relative(root, p)).collect();
    let mut args: Vec<&str> = if has_head {
        vec!["restore", "--staged", "--"]
    } else {
        // Before the first commit there's no HEAD to restore from.
        vec!["rm", "--cached", "-q", "-r", "--"]
    };
    args.extend(relative.iter().map(String::as_str));
    run(root, &args, None, QUICK).await.map(|_| ())
}

/// Throws away unstaged changes to tracked files (untracked files are deleted by the UI, to
/// the Recycle Bin).
pub async fn discard(root: &Path, paths: &[PathBuf]) -> Result<(), GitError> {
    let relative: Vec<String> = paths.iter().map(|p| relative(root, p)).collect();
    let mut args = vec!["restore", "--worktree", "--"];
    args.extend(relative.iter().map(String::as_str));
    run(root, &args, None, QUICK).await.map(|_| ())
}

/// Puts `text` in the index as `path`'s staged content (staging or unstaging one hunk), in
/// `format` (the encoding and line endings of the index version).
pub async fn set_index(
    root: &Path,
    path: &Path,
    text: &str,
    format: &TextFormat,
) -> Result<(), GitError> {
    let bytes = TextFile::with_format(&format.encoding, format.bom, format.crlf)
        .encode(text)
        .map_err(|e| GitError::Failed(e.to_string()))?;
    let rel = relative(root, path);
    let mode = match run(root, &["ls-files", "-s", "--", &rel], None, QUICK).await {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .split(' ')
            .next()
            .filter(|m| m.len() == 6)
            .unwrap_or("100644")
            .to_string(),
        Err(_) => "100644".into(),
    };
    let blob = run(
        root,
        &["hash-object", "-w", "--stdin", "--path", &rel],
        Some(&bytes),
        QUICK,
    )
    .await?;
    let oid = String::from_utf8_lossy(&blob.stdout).trim().to_string();
    let info = format!("{mode},{oid},{rel}");
    run(
        root,
        &["update-index", "--add", "--cacheinfo", &info],
        None,
        QUICK,
    )
    .await
    .map(|_| ())
}

pub async fn commit(
    root: &Path,
    message: &str,
    amend: bool,
    all: bool,
) -> Result<String, GitError> {
    let mut args = vec!["commit", "--file=-", "--cleanup=strip"];
    if amend {
        args.push("--amend");
    }
    if all {
        args.push("--all");
    }
    let out = run(root, &args, Some(message.as_bytes()), QUICK).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub commit: String,
    pub subject: String,
    /// When the last commit was made, in seconds since 1970.
    pub date: i64,
}

pub async fn branches(root: &Path) -> Result<Vec<Branch>, GitError> {
    let format = "%(HEAD)%00%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:unix)%00%(contents:subject)";
    let out = run(
        root,
        &[
            "for-each-ref",
            &format!("--format={format}"),
            "--sort=-committerdate",
            "refs/heads",
            "refs/remotes",
        ],
        None,
        QUICK,
    )
    .await?;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            if f.len() < 7 || f[1].ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: f[2].to_string(),
                remote: f[1].starts_with("refs/remotes/"),
                current: f[0] == "*",
                upstream: Some(f[3].to_string()).filter(|u| !u.is_empty()),
                commit: f[4].to_string(),
                date: f[5].parse().unwrap_or(0),
                subject: f[6].to_string(),
            })
        })
        .collect())
}

/// Switches to `branch`; with `create`, makes it first (from `start`, or HEAD).
pub async fn switch(
    root: &Path,
    branch: &str,
    create: bool,
    start: Option<&str>,
) -> Result<(), GitError> {
    let mut args = vec!["switch"];
    if create {
        args.push("-c");
    }
    args.push(branch);
    if let Some(start) = start {
        args.push(start);
    }
    run(root, &args, None, QUICK).await.map(|_| ())
}

pub async fn delete_branch(root: &Path, branch: &str, force: bool) -> Result<(), GitError> {
    run(
        root,
        &["branch", if force { "-D" } else { "-d" }, "--", branch],
        None,
        QUICK,
    )
    .await
    .map(|_| ())
}

/// fetch, pull or push. Their progress goes to stderr, which is returned for the Output panel.
pub async fn remote(root: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = run(root, args, None, NETWORK).await?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok([stdout, out.stderr]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    pub date: i64,
    pub subject: String,
}

/// The newest commits, of the whole repository or of one file (following renames).
pub async fn log(root: &Path, path: Option<&Path>, limit: u32) -> Result<Vec<Commit>, GitError> {
    let count = format!("-n{limit}");
    let mut args = vec![
        "log",
        &count,
        "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s",
    ];
    let rel = path.map(|p| relative(root, p));
    if let Some(rel) = &rel {
        args.extend(["--follow", "--", rel.as_str()]);
    }
    let out = match run(root, &args, None, QUICK).await {
        Ok(out) => out,
        // No commits yet.
        Err(GitError::Failed(message)) if message.contains("does not have any commits") => {
            return Ok(Vec::new());
        }
        Err(err) => return Err(err),
    };
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            (f.len() >= 6).then(|| Commit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                date: f[4].parse().unwrap_or(0),
                subject: f[5].to_string(),
            })
        })
        .collect())
}

/// Who last changed each line. `text` is the editor's current text (so unsaved lines show as
/// not committed yet).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line in the current text.
    pub line: u32,
    pub hash: String,
    pub author: String,
    pub date: i64,
    pub subject: String,
}

pub async fn blame(root: &Path, path: &Path, text: &str) -> Result<Vec<BlameLine>, GitError> {
    let rel = relative(root, path);
    let out = run(
        root,
        &["blame", "--porcelain", "--contents", "-", "--", &rel],
        Some(text.as_bytes()),
        QUICK,
    )
    .await?;
    Ok(parse_blame(&String::from_utf8_lossy(&out.stdout)))
}

pub fn parse_blame(raw: &str) -> Vec<BlameLine> {
    #[derive(Default, Clone)]
    struct Info {
        author: String,
        date: i64,
        subject: String,
    }
    let mut known: std::collections::HashMap<String, Info> = Default::default();
    let mut lines = Vec::new();
    let mut current: Option<(String, u32)> = None;
    for line in raw.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            let _ = content;
            if let Some((hash, number)) = current.take() {
                let info = known.get(&hash).cloned().unwrap_or_default();
                lines.push(BlameLine {
                    line: number,
                    hash,
                    author: info.author,
                    date: info.date,
                    subject: info.subject,
                });
            }
            continue;
        }
        let mut parts = line.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.chars().all(|c| c.is_ascii_hexdigit()) {
            let _original = parts.next();
            let final_line = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
            known.entry(first.to_string()).or_default();
            current = Some((first.to_string(), final_line));
            continue;
        }
        let Some((hash, _)) = &current else { continue };
        let rest = line[first.len()..].trim_start();
        let info = known.entry(hash.clone()).or_default();
        match first {
            "author" => info.author = rest.to_string(),
            "author-time" => info.date = rest.parse().unwrap_or(0),
            "summary" => info.subject = rest.to_string(),
            _ => {}
        }
    }
    lines
}

pub async fn stash(root: &Path, args: &[&str]) -> Result<String, GitError> {
    let mut all = vec!["stash"];
    all.extend_from_slice(args);
    let out = run(root, &all, None, QUICK).await?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub async fn init(dir: &Path) -> Result<(), GitError> {
    run(dir, &["init"], None, QUICK).await.map(|_| ())
}

pub async fn clone(url: &str, dest: &Path) -> Result<String, GitError> {
    let parent = dest.parent().unwrap_or(dest);
    let name = dest
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    remote(parent, &["clone", "--progress", "--", url, &name]).await
}

/// Clones only the newest commit (installing a plugin from its repository).
pub async fn clone_shallow(url: &str, dest: &Path) -> Result<String, GitError> {
    let parent = dest.parent().unwrap_or(dest);
    let name = dest
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    remote(parent, &["clone", "--depth", "1", "--", url, &name]).await
}

/// Settings Git needs for a first commit (shown in the UI when they're missing).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
}

pub async fn identity(root: &Path) -> Identity {
    let get = |key: &'static str| async move {
        run(root, &["config", "--get", key], None, QUICK)
            .await
            .ok()
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Identity {
        name: get("user.name").await,
        email: get("user.email").await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(dir: &Path, args: &[&str]) {
        run(dir, args, None, QUICK).await.unwrap();
    }

    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]).await;
        git(root, &["config", "user.name", "Lathe Test"]).await;
        git(root, &["config", "user.email", "test@lathe.invalid"]).await;
        git(root, &["config", "core.autocrlf", "false"]).await;
        dir
    }

    #[test]
    fn parses_porcelain_v2() {
        let root = Path::new("C:\\repo");
        let raw = b"# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a file.txt\0\
2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\0old.txt\0\
u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt\0? notes.md\0";
        let status = parse_status(root, raw);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.files.len(), 4);
        assert_eq!(status.files[0].path, "C:\\repo\\src\\a file.txt");
        assert_eq!(
            (status.files[0].index, status.files[0].worktree),
            ('.', 'M')
        );
        assert_eq!(
            status.files[1].orig_path.as_deref(),
            Some("C:\\repo\\old.txt")
        );
        assert_eq!(status.files[1].index, 'R');
        assert!(status.files[2].conflict);
        assert_eq!(status.files[3].index, '?');
    }

    #[tokio::test]
    async fn stages_commits_and_branches() {
        let dir = repo().await;
        let root = dir.path();
        let file = root.join("a.txt");
        std::fs::write(&file, "one\r\ntwo\r\n").unwrap();
        let status = status(root).await.unwrap();
        assert_eq!(status.files[0].index, '?');
        assert!(status.head.is_none());
        stage(root, std::slice::from_ref(&file)).await.unwrap();
        assert_eq!(super::status(root).await.unwrap().files[0].index, 'A');
        commit(root, "First\n\nbody", false, false).await.unwrap();
        let after = super::status(root).await.unwrap();
        assert!(after.files.is_empty());
        assert_eq!(after.branch.as_deref(), Some("main"));
        let head = show(root, "HEAD", &file).await.unwrap().unwrap();
        assert_eq!(head.text, "one\ntwo\n");
        assert!(head.format.crlf);
        switch(root, "feature", true, None).await.unwrap();
        let names: Vec<String> = branches(root)
            .await
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert!(names.contains(&"main".to_string()) && names.contains(&"feature".to_string()));
        let commits = log(root, Some(&file), 10).await.unwrap();
        assert_eq!(commits[0].subject, "First");
    }

    #[tokio::test]
    async fn stages_exact_contents_for_one_hunk() {
        let dir = repo().await;
        let root = dir.path();
        let file = root.join("a.txt");
        std::fs::write(&file, "one\r\ntwo\r\n").unwrap();
        stage(root, std::slice::from_ref(&file)).await.unwrap();
        commit(root, "First", false, false).await.unwrap();
        std::fs::write(&file, "ONE\r\ntwo\r\nthree\r\n").unwrap();
        // Stage only the first change, keeping the file's CRLF endings.
        let index = show(root, "", &file).await.unwrap().unwrap();
        set_index(root, &file, "ONE\ntwo\n", &index.format)
            .await
            .unwrap();
        let staged = run(root, &["diff", "--cached", "--", "a.txt"], None, QUICK)
            .await
            .unwrap();
        let staged = String::from_utf8_lossy(&staged.stdout);
        assert!(staged.contains("-one\r") && staged.contains("+ONE\r"));
        assert!(!staged.contains("three"));
        let unstaged = run(root, &["diff", "--", "a.txt"], None, QUICK)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&unstaged.stdout).contains("+three"));
    }

    #[tokio::test]
    async fn blames_unsaved_text() {
        let dir = repo().await;
        let root = dir.path();
        let file = root.join("a.txt");
        std::fs::write(&file, "one\ntwo\n").unwrap();
        stage(root, std::slice::from_ref(&file)).await.unwrap();
        commit(root, "First", false, false).await.unwrap();
        let lines = blame(root, &file, "one\nchanged\n").await.unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].author, "Lathe Test");
        assert_eq!(lines[0].subject, "First");
        assert!(lines[1].hash.starts_with("0000000"));
    }
}
