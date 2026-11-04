//! Compilers and runtimes on this PC: which are installed, where, and which version. The Run
//! button uses them; missing ones can be installed with winget (Lathe shows you the command
//! and asks first).
//!
//! Microsoft's C++ compiler (MSVC) is never on PATH: it lives in Visual Studio's Build Tools
//! and needs the "developer environment" that `VsDevCmd.bat` sets up. Lathe captures that
//! environment once and caches it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW,
};
use windows::core::HSTRING;

use crate::run::{capture, which};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    pub id: &'static str,
    pub name: &'static str,
    /// What it's for: "Python", "C and C++"…
    pub languages: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
    /// The winget package that installs it, when it's missing.
    pub winget: Option<&'static str>,
}

struct Probe {
    id: &'static str,
    name: &'static str,
    languages: &'static str,
    programs: &'static [&'static str],
    /// Folders to look in when the program isn't on PATH (installers that skip PATH).
    extra_dirs: &'static [&'static str],
    version_args: &'static [&'static str],
    winget: Option<&'static str>,
}

const PROBES: &[Probe] = &[
    Probe {
        id: "python",
        name: "Python",
        languages: "Python",
        programs: &["python", "py"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("Python.Python.3.13"),
    },
    Probe {
        id: "node",
        name: "Node.js",
        languages: "JavaScript, TypeScript",
        programs: &["node"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("OpenJS.NodeJS.LTS"),
    },
    Probe {
        id: "java",
        name: "Java (JDK)",
        languages: "Java",
        programs: &["javac"],
        extra_dirs: &[],
        version_args: &["-version"],
        winget: Some("EclipseAdoptium.Temurin.21.JDK"),
    },
    Probe {
        id: "rust",
        name: "Rust",
        languages: "Rust",
        programs: &["rustc"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("Rustlang.Rustup"),
    },
    Probe {
        id: "clang",
        name: "LLVM (clang)",
        languages: "C, C++",
        programs: &["clang++"],
        extra_dirs: &[r"C:\Program Files\LLVM\bin"],
        version_args: &["--version"],
        winget: Some("LLVM.LLVM"),
    },
    Probe {
        id: "gcc",
        name: "MinGW (g++)",
        languages: "C, C++",
        programs: &["g++"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("BrechtSanders.WinLibs.POSIX.UCRT"),
    },
    Probe {
        id: "go",
        name: "Go",
        languages: "Go",
        programs: &["go"],
        extra_dirs: &[r"C:\Program Files\Go\bin"],
        version_args: &["version"],
        winget: Some("GoLang.Go"),
    },
    Probe {
        id: "dotnet",
        name: ".NET SDK",
        languages: "C#",
        programs: &["dotnet"],
        extra_dirs: &[r"C:\Program Files\dotnet"],
        version_args: &["--version"],
        winget: Some("Microsoft.DotNet.SDK.10"),
    },
    Probe {
        id: "deno",
        name: "Deno",
        languages: "JavaScript, TypeScript",
        programs: &["deno"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("DenoLand.Deno"),
    },
    Probe {
        id: "bun",
        name: "Bun",
        languages: "JavaScript, TypeScript",
        programs: &["bun"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("Oven-sh.Bun"),
    },
    Probe {
        id: "ruby",
        name: "Ruby",
        languages: "Ruby",
        programs: &["ruby"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: None,
    },
    Probe {
        id: "php",
        name: "PHP",
        languages: "PHP",
        programs: &["php"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: None,
    },
    Probe {
        id: "lua",
        name: "Lua",
        languages: "Lua",
        programs: &["lua"],
        extra_dirs: &[],
        version_args: &["-v"],
        winget: None,
    },
    Probe {
        id: "pwsh",
        name: "PowerShell 7",
        languages: "PowerShell",
        programs: &["pwsh"],
        extra_dirs: &[r"C:\Program Files\PowerShell\7"],
        version_args: &["--version"],
        winget: Some("Microsoft.PowerShell"),
    },
    Probe {
        id: "git",
        name: "Git",
        languages: "Source control",
        programs: &["git"],
        extra_dirs: &[],
        version_args: &["--version"],
        winget: Some("Git.Git"),
    },
];

fn find_program(probe: &Probe) -> Option<PathBuf> {
    for program in probe.programs {
        if let Some(path) = which(program) {
            return Some(path);
        }
        for dir in probe.extra_dirs {
            let candidate = Path::new(dir).join(format!("{program}.exe"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The first line that looks like a version ("Python 3.14.7", "v24.19.0", "rustc 1.99.1 (…)").
fn version_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| line.chars().any(|c| c.is_ascii_digit()))
        .map(|line| line.chars().take(120).collect())
}

/// Every toolchain Lathe knows, found or not, plus MSVC.
pub async fn detect(cache_dir: &Path) -> Vec<Toolchain> {
    let mut tasks = Vec::new();
    for probe in PROBES {
        tasks.push(tokio::spawn(async move {
            let path = find_program(probe);
            let mut version = None;
            if let Some(path) = &path {
                let args: Vec<String> =
                    probe.version_args.iter().map(|a| (*a).to_owned()).collect();
                if let Ok(ran) = capture(
                    path,
                    &args,
                    &std::env::temp_dir(),
                    &[],
                    Duration::from_secs(8),
                )
                .await
                {
                    version = version_line(&ran.output);
                }
            }
            Toolchain {
                id: probe.id,
                name: probe.name,
                languages: probe.languages,
                path: path.map(|p| p.display().to_string()),
                version,
                winget: probe.winget,
            }
        }));
    }
    let mut found = Vec::new();
    for task in tasks {
        if let Ok(toolchain) = task.await {
            found.push(toolchain);
        }
    }
    let msvc = msvc_install().await;
    found.insert(
        4,
        Toolchain {
            id: "msvc",
            name: "Visual Studio Build Tools (MSVC)",
            languages: "C, C++",
            version: msvc.as_ref().map(|m| m.version.clone()),
            path: msvc.as_ref().map(|m| m.path.display().to_string()),
            winget: Some("Microsoft.VisualStudio.2022.BuildTools"),
        },
    );
    let _ = cache_dir;
    found
}

/// A Visual Studio (or Build Tools) installation with the C++ compiler.
#[derive(Debug, Clone)]
pub struct MsvcInstall {
    pub path: PathBuf,
    pub version: String,
}

fn vswhere() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramFiles(x86)")?;
    let path = PathBuf::from(base).join(r"Microsoft Visual Studio\Installer\vswhere.exe");
    path.is_file().then_some(path)
}

/// The newest installation with the C++ tools, as vswhere reports it.
pub async fn msvc_install() -> Option<MsvcInstall> {
    let vswhere = vswhere()?;
    let mut command = crate::proc::command(&vswhere);
    command
        .args([
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-latest",
            "-format",
            "json",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    // Started suspended by `proc::command`; `proc::spawn` puts it in its job and resumes it.
    let crate::proc::Process { child, job } = crate::proc::spawn(&mut command).ok()?;
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .ok()?
        .ok()?;
    drop(job);
    let list: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).ok()?;
    let first = list.first()?;
    Some(MsvcInstall {
        path: PathBuf::from(first.get("installationPath")?.as_str()?),
        version: first
            .get("catalog")
            .and_then(|c| c.get("productDisplayVersion"))
            .and_then(|v| v.as_str())
            .or_else(|| first.get("installationVersion").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_owned(),
    })
}

#[derive(Serialize, Deserialize)]
struct CachedEnv {
    install: String,
    stamp: i64,
    vars: Vec<(String, String)>,
}

/// The developer environment of the newest MSVC installation: the variables `VsDevCmd.bat`
/// adds or changes (PATH, INCLUDE, LIB…). Cached in `cache_dir`, since capturing it takes a
/// second or two.
pub async fn msvc_environment(cache_dir: &Path) -> std::io::Result<Option<Vec<(String, String)>>> {
    let Some(install) = msvc_install().await else {
        return Ok(None);
    };
    let bat = install.path.join(r"Common7\Tools\VsDevCmd.bat");
    if !bat.is_file() {
        return Ok(None);
    }
    let stamp = std::fs::metadata(&bat)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let cache = cache_dir.join("msvc-env.json");
    if let Ok(text) = std::fs::read_to_string(&cache)
        && let Ok(cached) = serde_json::from_str::<CachedEnv>(&text)
        && cached.install == install.path.display().to_string()
        && cached.stamp == stamp
    {
        return Ok(Some(cached.vars));
    }
    let cmd = which("cmd").ok_or_else(|| std::io::Error::other("cmd.exe is missing"))?;
    // cmd's /s /c strips the outer quotes and runs the rest as written.
    let line = format!(
        "\"\"{}\" -arch=amd64 -host_arch=amd64 -no_logo && set\"",
        bat.display()
    );
    let mut command = crate::proc::command(&cmd);
    command
        .args(["/d", "/s", "/c"])
        .raw_arg(&line)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut process = crate::proc::spawn(&mut command)?;
    let output = tokio::time::timeout(Duration::from_secs(60), async {
        let mut out = Vec::new();
        if let Some(mut stdout) = process.child.stdout.take() {
            use tokio::io::AsyncReadExt;
            stdout.read_to_end(&mut out).await?;
        }
        process.child.wait().await?;
        Ok::<_, std::io::Error>(out)
    })
    .await
    .map_err(|_| std::io::Error::other("VsDevCmd.bat took too long"))??;
    let text = crate::shell::decode(&output);
    let current: HashMap<String, String> = std::env::vars()
        .map(|(k, v)| (k.to_ascii_uppercase(), v))
        .collect();
    let vars: Vec<(String, String)> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(name, _)| !name.is_empty() && !name.starts_with('='))
        .filter(|(name, value)| {
            current.get(&name.to_ascii_uppercase()).map(String::as_str) != Some(*value)
        })
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    if !vars
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("INCLUDE"))
    {
        return Ok(None);
    }
    let cached = CachedEnv {
        install: install.path.display().to_string(),
        stamp,
        vars: vars.clone(),
    };
    if let Ok(json) = serde_json::to_string(&cached) {
        let _ = crate::files::write_atomic(&cache, json.as_bytes());
    }
    Ok(Some(vars))
}

fn registry_string(root: HKEY, key: &str, value: &str) -> Option<String> {
    let key = HSTRING::from(key);
    let value = HSTRING::from(value);
    let mut size = 0u32;
    // SAFETY: two-call pattern: size first, then the data into a buffer of that size.
    unsafe {
        let flags =
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | windows::Win32::System::Registry::RRF_NOEXPAND;
        if RegGetValueW(root, &key, &value, flags, None, None, Some(&mut size)) != ERROR_SUCCESS {
            return None;
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        if RegGetValueW(
            root,
            &key,
            &value,
            flags,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }
}

/// Expands `%NAME%` references from Lathe's own environment.
fn expand(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(value) if !name.is_empty() => out.push_str(&value),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Re-reads PATH from the registry (machine, then user), as a newly started program would see
/// it, so tools installed while Lathe runs are found without restarting it.
pub fn refresh_path() {
    let machine = registry_string(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        "Path",
    );
    let user = registry_string(HKEY_CURRENT_USER, "Environment", "Path");
    let joined = [machine, user]
        .into_iter()
        .flatten()
        .map(|p| expand(&p))
        .collect::<Vec<_>>()
        .join(";");
    if !joined.trim().is_empty() {
        // SAFETY: Lathe changes PATH only here, from a command handler, while no other thread
        // reads the environment in a way that could observe a torn value.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

/// The winget command line that installs `package`, as shown to you before it runs.
pub fn winget_args(package: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "install",
        "--id",
        package,
        "--exact",
        "--source",
        "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if package == "Microsoft.VisualStudio.2022.BuildTools" {
        // Build Tools without the C++ workload has no compiler.
        args.push("--override".into());
        args.push(
            "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
                .into(),
        );
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_the_first_line_with_digits() {
        assert_eq!(
            version_line("Python 3.14.7\n").as_deref(),
            Some("Python 3.14.7")
        );
        assert_eq!(version_line("\nv24.19.0").as_deref(), Some("v24.19.0"));
        assert_eq!(version_line("no digits here"), None);
    }

    #[test]
    fn percent_variables_expand() {
        let windir = std::env::var("SystemRoot").unwrap();
        assert_eq!(
            expand(r"%SystemRoot%\System32"),
            format!(r"{windir}\System32")
        );
        assert_eq!(expand("%NOT_A_REAL_VAR_XYZ%;x"), "%NOT_A_REAL_VAR_XYZ%;x");
        assert_eq!(expand("100%"), "100%");
    }

    #[test]
    fn winget_installs_build_tools_with_the_cpp_workload() {
        let args = winget_args("Microsoft.VisualStudio.2022.BuildTools");
        assert!(args.iter().any(|a| a.contains("VCTools")));
        assert_eq!(winget_args("GoLang.Go")[2], "GoLang.Go");
    }

    #[tokio::test]
    async fn detects_this_pcs_toolchains() {
        let found = detect(&std::env::temp_dir()).await;
        assert!(found.iter().any(|t| t.id == "msvc"));
        // Git is a prerequisite for building Lathe, so it's always there.
        let git = found.iter().find(|t| t.id == "git").unwrap();
        assert!(git.path.is_some(), "{git:?}");
        assert!(
            git.version.as_deref().unwrap_or("").contains("git"),
            "{git:?}"
        );
    }
}
