//! The shells a terminal tab can open: PowerShell, Command Prompt, Git Bash, and WSL once a
//! Linux distribution is installed.

use std::path::PathBuf;

use serde::Serialize;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, RegCloseKey, RegOpenKeyExW, RegQueryInfoKeyW,
};
use windows::core::w;

use super::Launch;
use crate::shell::{Shell, ShellKind};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// "powershell", "cmd", "gitbash" or "wsl".
    pub id: String,
    pub title: String,
    pub path: String,
}

/// Every shell available on this PC, the default (PowerShell) first.
pub fn profiles() -> Vec<Profile> {
    ["powershell", "cmd", "gitbash", "wsl"]
        .iter()
        .filter_map(|id| {
            let launch = launch(id)?;
            Some(Profile {
                id: (*id).to_owned(),
                title: launch.title.clone(),
                path: launch.program.display().to_string(),
            })
        })
        .collect()
}

/// How to start the shell with this profile id, if it's installed.
pub fn launch(id: &str) -> Option<Launch> {
    match id {
        "powershell" => Shell::find(ShellKind::PowerShell).map(|s| Launch::shell(&s)),
        "gitbash" => Shell::find(ShellKind::GitBash).map(|s| Launch::shell(&s)),
        "cmd" => {
            command_prompt().map(|p| Launch::program("Command Prompt", p, Vec::new(), Vec::new()))
        }
        "wsl" => wsl().map(|p| Launch::program("WSL", p, Vec::new(), Vec::new())),
        _ => None,
    }
}

fn command_prompt() -> Option<PathBuf> {
    std::env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

/// `wsl.exe`, but only when a distribution is registered (otherwise it just prints help).
fn wsl() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os("SystemRoot")?)
        .join("System32")
        .join("wsl.exe");
    (path.is_file() && wsl_distributions() > 0).then_some(path)
}

fn wsl_distributions() -> u32 {
    let mut key = HKEY::default();
    // SAFETY: valid key path; `key` is closed below when it was opened.
    unsafe {
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Lxss"),
            None,
            KEY_READ,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return 0;
        }
        let mut subkeys = 0u32;
        let status = RegQueryInfoKeyW(
            key,
            None,
            None,
            None,
            Some(&mut subkeys),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let _ = RegCloseKey(key);
        if status == ERROR_SUCCESS { subkeys } else { 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_and_command_prompt_are_always_there() {
        let ids: Vec<String> = profiles().into_iter().map(|p| p.id).collect();
        assert_eq!(ids.first().map(String::as_str), Some("powershell"));
        assert!(ids.iter().any(|id| id == "cmd"), "{ids:?}");
        assert!(launch("nope").is_none());
    }
}
