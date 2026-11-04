//! Plugins (docs/plugins.md). Each lives in its own folder under `<data>\plugins\<id>`, described
//! by lathe-plugin.json. Installing goes through a staging folder: a folder is copied, a .zip
//! unpacked or a Git URL cloned there, its manifest checked, and only once you've seen what it
//! asks for does it move into place. The UI runs plugins (in sandboxed workers) and applies
//! their contributions; this module only keeps the files.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil;

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, PluginError>;

fn invalid(message: impl Into<String>) -> PluginError {
    PluginError::Invalid(message.into())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Engines {
    /// The Lathe versions it works with: "*", ">=0.1.0" or "^0.1.0".
    #[serde(default)]
    pub lathe: Option<String>,
}

/// lathe-plugin.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// "publisher.name" or "name": lower-case letters, digits and dashes.
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub engines: Engines,
    /// The JavaScript module to run (plugins that only contribute themes or snippets have none).
    #[serde(default)]
    pub main: Option<String>,
    /// When to start it: "onStartup", "onCommand:<id>", "onLanguage:<id>".
    #[serde(default)]
    pub activation_events: Vec<String>,
    /// Commands, keybindings, settings, themes, snippets, language servers.
    #[serde(default)]
    pub contributes: Value,
    /// What it may do beyond its own sandbox: "workspace.read", "workspace.write", "terminal",
    /// "network".
    #[serde(default)]
    pub permissions: Vec<String>,
}

pub const PERMISSIONS: [&str; 4] = ["workspace.read", "workspace.write", "terminal", "network"];

#[derive(Debug, Clone, Serialize)]
pub struct Installed {
    pub manifest: Manifest,
    pub dir: PathBuf,
    pub enabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    disabled: Vec<String>,
}

fn valid_id(id: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.len() <= 64
            && p.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !p.starts_with('-')
    };
    let parts: Vec<&str> = id.split('.').collect();
    parts.len() <= 2 && parts.iter().all(|p| part(p))
}

/// A path inside the plugin's folder (no `..`, no drive or root), or None.
fn inside(dir: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(dir.join(relative))
}

/// Every path a manifest's contributions point at (themes, snippets, icons).
fn contributed_paths(contributes: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    for key in ["themes", "snippets"] {
        if let Some(list) = contributes.get(key).and_then(Value::as_array) {
            for item in list {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    paths.push(path.to_string());
                }
            }
        }
    }
    paths
}

fn version_parts(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
        parts.next().flatten().unwrap_or(0),
    ))
}

/// Whether `range` ("*", ">=x.y.z", "^x.y.z", or a version) includes `version`.
pub fn compatible(range: Option<&str>, version: &str) -> bool {
    let Some(range) = range.map(str::trim).filter(|r| !r.is_empty() && *r != "*") else {
        return true;
    };
    let Some(have) = version_parts(version) else {
        return true;
    };
    if let Some(min) = range.strip_prefix(">=") {
        return version_parts(min.trim()).is_none_or(|min| have >= min);
    }
    if let Some(base) = range.strip_prefix('^') {
        let Some(base) = version_parts(base.trim()) else {
            return true;
        };
        // ^0.y means the same minor (0.y.*); ^x means the same major.
        return have >= base
            && if base.0 == 0 {
                have.1 == base.1
            } else {
                have.0 == base.0
            };
    }
    version_parts(range).is_none_or(|exact| exact == have)
}

/// Reads and checks a folder's manifest.
pub fn validate(dir: &Path, app_version: &str) -> Result<Manifest> {
    let text = std::fs::read_to_string(dir.join("lathe-plugin.json"))
        .map_err(|_| invalid("There's no lathe-plugin.json in that folder."))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .map_err(|err| invalid(format!("lathe-plugin.json isn't valid: {err}")))?;
    if !valid_id(&manifest.id) {
        return Err(invalid(format!(
            "\"{}\" isn't a valid plugin id: use lower-case letters, digits and dashes, as in \"publisher.name\".",
            manifest.id
        )));
    }
    if manifest.name.trim().is_empty() || version_parts(&manifest.version).is_none() {
        return Err(invalid(
            "The manifest needs a name and a version like 1.0.0.",
        ));
    }
    if !compatible(manifest.engines.lathe.as_deref(), app_version) {
        return Err(invalid(format!(
            "{} needs Lathe {}, and this is {app_version}.",
            manifest.name,
            manifest.engines.lathe.as_deref().unwrap_or("")
        )));
    }
    for permission in &manifest.permissions {
        if !PERMISSIONS.contains(&permission.as_str()) {
            return Err(invalid(format!(
                "Lathe doesn't know the permission \"{permission}\"."
            )));
        }
    }
    let mut files: Vec<String> = contributed_paths(&manifest.contributes);
    files.extend(manifest.main.clone());
    for file in files {
        match inside(dir, &file) {
            Some(path) if path.is_file() => {}
            _ => return Err(invalid(format!("The plugin's file \"{file}\" is missing."))),
        }
    }
    Ok(manifest)
}

fn read_state(root: &Path) -> State {
    std::fs::read_to_string(root.join("state.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_state(root: &Path, state: &State) -> Result<()> {
    std::fs::create_dir_all(root)?;
    fsutil::write_atomic(
        &root.join("state.json"),
        &serde_json::to_vec_pretty(state).unwrap_or_default(),
    )?;
    Ok(())
}

/// The installed plugins, by name.
pub fn list(root: &Path, app_version: &str) -> Vec<Installed> {
    let state = read_state(root);
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name();
        if !dir.is_dir() || name.to_string_lossy().starts_with('.') {
            continue;
        }
        if let Ok(manifest) = validate(&dir, app_version) {
            let enabled = !state.disabled.contains(&manifest.id);
            found.push(Installed {
                manifest,
                dir,
                enabled,
            });
        }
    }
    found.sort_by(|a, b| {
        a.manifest
            .name
            .to_lowercase()
            .cmp(&b.manifest.name.to_lowercase())
    });
    found
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        // A clone's history and the usual tool folders aren't part of the plugin.
        if matches!(name.to_str(), Some(".git" | "node_modules")) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        let target = to.join(&name);
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn staging(root: &Path) -> PathBuf {
    root.join(".staging").join(crate::new_id())
}

/// The folder holding the manifest: the top, or its only subfolder (zips and repositories often
/// wrap the plugin in one).
fn plugin_folder(dir: &Path) -> Option<PathBuf> {
    if dir.join("lathe-plugin.json").is_file() {
        return Some(dir.to_path_buf());
    }
    let mut folders = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect::<Vec<_>>();
    if folders.len() == 1 {
        let only = folders.remove(0).path();
        if only.join("lathe-plugin.json").is_file() {
            return Some(only);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub staging_id: String,
    pub manifest: Manifest,
    /// Already installed: the version it would replace.
    pub replaces: Option<String>,
}

fn stage_dir(root: &Path, from: &Path, app_version: &str) -> Result<Staged> {
    let folder =
        plugin_folder(from).ok_or_else(|| invalid("There's no lathe-plugin.json there."))?;
    let manifest = validate(&folder, app_version)?;
    let target = staging(root);
    copy_dir(&folder, &target)?;
    let replaces = list(root, app_version)
        .into_iter()
        .find(|p| p.manifest.id == manifest.id)
        .map(|p| p.manifest.version);
    Ok(Staged {
        staging_id: target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        manifest,
        replaces,
    })
}

/// Copies a plugin folder into staging and reads its manifest.
pub fn stage_folder(root: &Path, from: &Path, app_version: &str) -> Result<Staged> {
    stage_dir(root, from, app_version)
}

/// Unpacks a .zip into staging (with Windows' tar.exe) and reads its manifest.
pub async fn stage_zip(root: &Path, zip: &Path, app_version: &str) -> Result<Staged> {
    let unpacked = staging(root);
    std::fs::create_dir_all(&unpacked)?;
    let result = match crate::tools::unpack(zip, &unpacked).await {
        Ok(()) => stage_dir(root, &unpacked, app_version),
        Err(err) => Err(invalid(format!("Couldn't unpack the .zip: {err}"))),
    };
    let _ = std::fs::remove_dir_all(&unpacked);
    result
}

/// Clones a Git URL (https only, no history) into staging and reads its manifest.
pub async fn stage_git(root: &Path, url: &str, app_version: &str) -> Result<Staged> {
    if !url.starts_with("https://") {
        return Err(invalid("Only https:// Git URLs can be installed."));
    }
    let cloned = staging(root);
    std::fs::create_dir_all(cloned.parent().unwrap_or(root))?;
    crate::git::clone_shallow(url, &cloned)
        .await
        .map_err(|err| invalid(format!("Couldn't clone it: {err}")))?;
    let result = stage_dir(root, &cloned, app_version);
    let _ = std::fs::remove_dir_all(&cloned);
    result
}

/// Moves a staged plugin into place (replacing an older copy).
pub fn install_staged(root: &Path, staging_id: &str, app_version: &str) -> Result<Manifest> {
    if staging_id.is_empty()
        || !staging_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(invalid("That install is no longer there."));
    }
    let staged = root.join(".staging").join(staging_id);
    let manifest = validate(&staged, app_version)?;
    let target = root.join(&manifest.id);
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(&staged, &target)?;
    Ok(manifest)
}

pub fn discard_staged(root: &Path, staging_id: &str) {
    if !staging_id.is_empty()
        && staging_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        let _ = std::fs::remove_dir_all(root.join(".staging").join(staging_id));
    }
}

pub fn uninstall(root: &Path, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(invalid("That isn't a plugin id."));
    }
    let dir = root.join(id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    set_enabled(root, id, true)
}

pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<()> {
    let mut state = read_state(root);
    state.disabled.retain(|d| d != id);
    if !enabled {
        state.disabled.push(id.to_string());
    }
    write_state(root, &state)
}

/// A file from an installed plugin's folder, or None if it isn't one of its files.
pub fn read_file(root: &Path, id: &str, relative: &str) -> Option<Vec<u8>> {
    if !valid_id(id) {
        return None;
    }
    let dir = root.join(id);
    let path = inside(&dir, relative)?;
    // Through a link it could leave the folder: compare where both really are.
    let real_dir = dunce::canonicalize(&dir).ok()?;
    let real = dunce::canonicalize(&path).ok()?;
    if !real.starts_with(&real_dir) || !real.is_file() {
        return None;
    }
    std::fs::read(real).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(dir: &Path, manifest: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("lathe-plugin.json"), manifest).unwrap();
        std::fs::write(dir.join("main.js"), "export function activate() {}").unwrap();
    }

    const MANIFEST: &str = r#"{"id": "sample.hello", "name": "Hello", "version": "1.0.0", "main": "main.js", "engines": {"lathe": ">=0.1.0"}, "permissions": ["workspace.read"]}"#;

    #[test]
    fn installs_through_staging_and_lists_it() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("plugins");
        let source = temp.path().join("src").join("hello");
        plugin(&source, MANIFEST);
        let staged = stage_folder(&root, &source, "0.1.0").unwrap();
        assert_eq!(staged.manifest.id, "sample.hello");
        assert_eq!(staged.replaces, None);
        assert!(
            list(&root, "0.1.0").is_empty(),
            "staged isn't installed yet"
        );
        install_staged(&root, &staged.staging_id, "0.1.0").unwrap();
        let installed = list(&root, "0.1.0");
        assert_eq!(installed.len(), 1);
        assert!(installed[0].enabled);
        set_enabled(&root, "sample.hello", false).unwrap();
        assert!(!list(&root, "0.1.0")[0].enabled);
        assert_eq!(
            read_file(&root, "sample.hello", "main.js").unwrap().len(),
            29
        );
        assert!(read_file(&root, "sample.hello", "../state.json").is_none());
        uninstall(&root, "sample.hello").unwrap();
        assert!(list(&root, "0.1.0").is_empty());
    }

    #[test]
    fn refuses_bad_manifests() {
        let temp = tempfile::tempdir().unwrap();
        let cases = [
            (
                r#"{"id": "Bad Id", "name": "x", "version": "1.0.0"}"#,
                "valid plugin id",
            ),
            (
                r#"{"id": "a.b", "name": "x", "version": "1.0.0", "main": "../evil.js"}"#,
                "missing",
            ),
            (
                r#"{"id": "a.b", "name": "x", "version": "1.0.0", "permissions": ["root"]}"#,
                "permission",
            ),
            (
                r#"{"id": "a.b", "name": "x", "version": "1.0.0", "engines": {"lathe": ">=9.0.0"}}"#,
                "needs Lathe",
            ),
        ];
        for (i, (manifest, message)) in cases.iter().enumerate() {
            let dir = temp.path().join(format!("p{i}"));
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("lathe-plugin.json"), manifest).unwrap();
            let err = validate(&dir, "0.1.0").unwrap_err().to_string();
            assert!(err.contains(message), "{manifest}: {err}");
        }
    }

    #[test]
    fn version_ranges() {
        assert!(compatible(None, "0.1.0"));
        assert!(compatible(Some(">=0.1.0"), "0.2.3"));
        assert!(!compatible(Some(">=0.3.0"), "0.2.3"));
        assert!(compatible(Some("^0.2.0"), "0.2.9"));
        assert!(!compatible(Some("^0.2.0"), "0.3.0"));
        assert!(compatible(Some("^1.2.0"), "1.9.0"));
    }
}
