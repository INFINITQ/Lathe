//! Plugins (`lathe_core::plugins`): listing them, installing through staging, turning them on and
//! off, and the `lathe-plugin` origin their code runs on (http://lathe-plugin.localhost):
//! `/__host/<id>/` is a plugin's host page, which starts its Worker, and `/<id>/<path>` are the
//! plugin's own files. That origin can't call Lathe's commands; a plugin reaches Lathe only
//! through the messages Lathe's page answers, which check its permissions.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use lathe_core::plugins::{self, Installed, Manifest, PluginError, Staged};
use tauri::http::{Request, Response, header};
use tauri::{Manager, Runtime, State, UriSchemeContext};

use crate::error::{Error, Result};
use crate::state::{AppState, absolute};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HOST_JS: &str = include_str!("plugin_host/host.js");
const WORKER_JS: &str = include_str!("plugin_host/worker.js");
const HOST_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><script src=\"host.js\"></script></head><body></body></html>";
const ORIGIN: &str = "http://lathe-plugin.localhost";

impl From<PluginError> for Error {
    fn from(err: PluginError) -> Self {
        match err {
            PluginError::Io(io) => Error::Io(io),
            other => Error::Invalid(other.to_string()),
        }
    }
}

fn root(data: &Path) -> PathBuf {
    data.join("plugins")
}

#[tauri::command]
pub fn plugins_list(state: State<'_, AppState>) -> Vec<Installed> {
    plugins::list(&root(&state.data_dir), VERSION)
}

/// Copies (folder), unpacks (zip) or clones (git) a plugin into staging, and reads its manifest.
#[tauri::command]
pub async fn plugin_stage(
    state: State<'_, AppState>,
    kind: String,
    source: String,
) -> Result<Staged> {
    let root = root(&state.data_dir);
    match kind.as_str() {
        "folder" => Ok(plugins::stage_folder(&root, &absolute(&source)?, VERSION)?),
        "zip" => Ok(plugins::stage_zip(&root, &absolute(&source)?, VERSION).await?),
        "git" => Ok(plugins::stage_git(&root, source.trim(), VERSION).await?),
        _ => Err(Error::Invalid(format!(
            "Lathe can't install from \"{kind}\"."
        ))),
    }
}

#[tauri::command]
pub fn plugin_install(state: State<'_, AppState>, staging_id: String) -> Result<Manifest> {
    Ok(plugins::install_staged(
        &root(&state.data_dir),
        &staging_id,
        VERSION,
    )?)
}

#[tauri::command]
pub fn plugin_discard(state: State<'_, AppState>, staging_id: String) {
    plugins::discard_staged(&root(&state.data_dir), &staging_id);
}

#[tauri::command]
pub fn plugin_uninstall(state: State<'_, AppState>, id: String) -> Result<()> {
    Ok(plugins::uninstall(&root(&state.data_dir), &id)?)
}

#[tauri::command]
pub fn plugin_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> Result<()> {
    Ok(plugins::set_enabled(&root(&state.data_dir), &id, enabled)?)
}

/// A text file from a plugin's folder (its themes and snippets).
#[tauri::command]
pub fn plugin_read_text(state: State<'_, AppState>, id: String, path: String) -> Result<String> {
    let bytes = plugins::read_file(&root(&state.data_dir), &id, &path)
        .ok_or_else(|| Error::NotFound(format!("The plugin has no file \"{path}\".")))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// What a plugin's code may load: its own scripts only, and the network with "network".
fn policy(network: bool) -> String {
    format!(
        "default-src 'none'; script-src {ORIGIN}; worker-src {ORIGIN}; img-src data: {ORIGIN}; connect-src {}; base-uri 'none'; form-action 'none'",
        if network { "https:" } else { "'none'" }
    )
}

fn decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&path[i + 1..i + 3], 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn reply(
    status: u16,
    kind: &str,
    csp: Option<String>,
    body: Vec<u8>,
) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, kind)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(csp) = csp {
        builder = builder.header("Content-Security-Policy", csp);
    }
    builder
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
}

fn missing() -> Response<Cow<'static, [u8]>> {
    reply(404, "text/plain", None, b"Not found".to_vec())
}

/// Serves http://lathe-plugin.localhost/…
pub fn respond<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let Some(state) = ctx.app_handle().try_state::<AppState>() else {
        return missing();
    };
    let root = root(&state.data_dir);
    let path = decode(request.uri().path());
    let trimmed = path.trim_start_matches('/');
    let (first, rest) = trimmed.split_once('/').unwrap_or((trimmed, ""));
    if first == "__host" {
        let (id, file) = rest.split_once('/').unwrap_or((rest, ""));
        let Some(plugin) = plugins::list(&root, VERSION)
            .into_iter()
            .find(|p| p.manifest.id == id && p.enabled)
        else {
            return missing();
        };
        let network = plugin.manifest.permissions.iter().any(|p| p == "network");
        return match file {
            "" | "index.html" => reply(
                200,
                "text/html; charset=utf-8",
                Some(policy(false)),
                HOST_HTML.into(),
            ),
            "host.js" => reply(
                200,
                "text/javascript; charset=utf-8",
                Some(policy(false)),
                HOST_JS.into(),
            ),
            "worker.js" => {
                let Some(main) = plugin.manifest.main.as_deref() else {
                    return missing();
                };
                let info = serde_json::json!({
                    "id": plugin.manifest.id,
                    "version": plugin.manifest.version,
                    "main": format!("/{}/{}", plugin.manifest.id, main.trim_start_matches("./")),
                });
                // The declaration itself (the name also appears in the file's comments).
                let script = WORKER_JS.replacen(
                    "const PLUGIN = __PLUGIN__;",
                    &format!("const PLUGIN = {info};"),
                    1,
                );
                reply(
                    200,
                    "text/javascript; charset=utf-8",
                    Some(policy(network)),
                    script.into_bytes(),
                )
            }
            _ => missing(),
        };
    }
    let network = plugins::list(&root, VERSION)
        .into_iter()
        .find(|p| p.manifest.id == first)
        .is_some_and(|p| p.manifest.permissions.iter().any(|p| p == "network"));
    match plugins::read_file(&root, first, rest) {
        Some(bytes) => reply(200, content_type(rest), Some(policy(network)), bytes),
        None => missing(),
    }
}
