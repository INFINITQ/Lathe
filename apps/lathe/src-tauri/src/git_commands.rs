//! Source control for the UI (`lathe_core::git`). Every command takes the repository's top
//! folder (from `git_status`), and only the git operations the UI offers can be run.

use std::path::PathBuf;

use lathe_core::files::TextFormat;
use lathe_core::git::{self, BlameLine, Blob, Branch, Commit, GitError, Identity, RepoStatus};

use crate::error::{Error, Result};
use crate::state::absolute;

impl From<GitError> for Error {
    fn from(err: GitError) -> Self {
        Error::Coded {
            kind: err.kind(),
            message: err.to_string(),
        }
    }
}

fn paths(list: &[String]) -> Result<Vec<PathBuf>> {
    list.iter().map(|p| absolute(p)).collect()
}

/// The repository that holds `folder`, or None (no repository, or Git isn't installed).
#[tauri::command]
pub async fn git_status(folder: String) -> Result<Option<RepoStatus>> {
    let folder = absolute(&folder)?;
    let root = match git::toplevel(&folder).await {
        Ok(Some(root)) => root,
        Ok(None) | Err(GitError::NotInstalled) => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    Ok(Some(git::status(&root).await?))
}

#[tauri::command]
pub async fn git_show(root: String, rev: String, path: String) -> Result<Option<Blob>> {
    if rev.starts_with('-') {
        return Err(Error::Invalid("That isn't a revision.".into()));
    }
    Ok(git::show(&absolute(&root)?, &rev, &absolute(&path)?).await?)
}

#[tauri::command]
pub async fn git_stage(root: String, files: Vec<String>) -> Result<()> {
    Ok(git::stage(&absolute(&root)?, &paths(&files)?).await?)
}

#[tauri::command]
pub async fn git_unstage(root: String, files: Vec<String>, has_head: bool) -> Result<()> {
    Ok(git::unstage(&absolute(&root)?, &paths(&files)?, has_head).await?)
}

#[tauri::command]
pub async fn git_discard(root: String, files: Vec<String>) -> Result<()> {
    Ok(git::discard(&absolute(&root)?, &paths(&files)?).await?)
}

#[tauri::command]
pub async fn git_set_index(
    root: String,
    path: String,
    text: String,
    format: TextFormat,
) -> Result<()> {
    Ok(git::set_index(&absolute(&root)?, &absolute(&path)?, &text, &format).await?)
}

#[tauri::command]
pub async fn git_commit(root: String, message: String, amend: bool, all: bool) -> Result<String> {
    if message.trim().is_empty() && !amend {
        return Err(Error::Invalid("Write a commit message first.".into()));
    }
    Ok(git::commit(&absolute(&root)?, &message, amend, all).await?)
}

#[tauri::command]
pub async fn git_branches(root: String) -> Result<Vec<Branch>> {
    Ok(git::branches(&absolute(&root)?).await?)
}

fn branch_name(name: &str) -> Result<&str> {
    if name.is_empty() || name.starts_with('-') || name.contains(['\0', '\n']) {
        return Err(Error::Invalid(format!("{name} isn't a branch name.")));
    }
    Ok(name)
}

#[tauri::command]
pub async fn git_switch(
    root: String,
    branch: String,
    create: bool,
    start: Option<String>,
) -> Result<()> {
    let start = start.as_deref().map(branch_name).transpose()?;
    Ok(git::switch(&absolute(&root)?, branch_name(&branch)?, create, start).await?)
}

#[tauri::command]
pub async fn git_delete_branch(root: String, branch: String, force: bool) -> Result<()> {
    Ok(git::delete_branch(&absolute(&root)?, branch_name(&branch)?, force).await?)
}

/// fetch, pull or push (with the UI's own options only).
#[tauri::command]
pub async fn git_remote(root: String, action: String, options: Vec<String>) -> Result<String> {
    let allowed: &[&str] = match action.as_str() {
        "fetch" => &["--all", "--prune", "--progress"],
        "pull" => &["--rebase", "--ff-only", "--progress"],
        "push" => &[
            "--set-upstream",
            "--force-with-lease",
            "--progress",
            "origin",
            "HEAD",
            "--tags",
        ],
        _ => {
            return Err(Error::Invalid(format!(
                "git {action} isn't available here."
            )));
        }
    };
    if let Some(bad) = options.iter().find(|o| !allowed.contains(&o.as_str())) {
        return Err(Error::Invalid(format!(
            "{bad} isn't an option Lathe passes to git {action}."
        )));
    }
    let mut args = vec![action.as_str()];
    args.extend(options.iter().map(String::as_str));
    Ok(git::remote(&absolute(&root)?, &args).await?)
}

#[tauri::command]
pub async fn git_log(root: String, path: Option<String>, limit: u32) -> Result<Vec<Commit>> {
    let path = path.map(|p| absolute(&p)).transpose()?;
    Ok(git::log(&absolute(&root)?, path.as_deref(), limit.clamp(1, 1000)).await?)
}

#[tauri::command]
pub async fn git_blame(root: String, path: String, text: String) -> Result<Vec<BlameLine>> {
    Ok(git::blame(&absolute(&root)?, &absolute(&path)?, &text).await?)
}

#[tauri::command]
pub async fn git_stash(root: String, action: String, message: Option<String>) -> Result<String> {
    let root = absolute(&root)?;
    let output = match action.as_str() {
        "push" => {
            let message = message.unwrap_or_default();
            if message.is_empty() {
                git::stash(&root, &["push", "--include-untracked"]).await?
            } else {
                git::stash(&root, &["push", "--include-untracked", "-m", &message]).await?
            }
        }
        "pop" => git::stash(&root, &["pop"]).await?,
        "list" => git::stash(&root, &["list"]).await?,
        _ => {
            return Err(Error::Invalid(format!(
                "git stash {action} isn't available here."
            )));
        }
    };
    Ok(output)
}

#[tauri::command]
pub async fn git_init(folder: String) -> Result<()> {
    Ok(git::init(&absolute(&folder)?).await?)
}

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<String> {
    if !(url.starts_with("https://") || url.starts_with("git@") || url.starts_with("ssh://")) {
        return Err(Error::Invalid(
            "Clone from an https:// or SSH address.".into(),
        ));
    }
    Ok(git::clone(&url, &absolute(&dest)?).await?)
}

#[tauri::command]
pub async fn git_identity(root: String) -> Result<Identity> {
    Ok(git::identity(&absolute(&root)?).await)
}
