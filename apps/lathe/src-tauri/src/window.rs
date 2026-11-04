//! The main window: frameless with Lathe's own title bar, a solid themed background, and
//! hidden until the UI has painted (so it never flashes white).

use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};

use crate::state::AppState;
use crate::{Result, theme, webview2};

pub const MAIN: &str = "main";

/// Sent when files or folders are dropped on the window from File Explorer.
pub const DROP_EVENT: &str = "lathe://drop";

/// Runs before any page script: removes WebRTC and switches off DNS prefetching.
const INIT_SCRIPT: &str = include_str!("init.js");

static READY: AtomicBool = AtomicBool::new(false);

/// What Lathe was started with: `lathe <folder or files…>`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub args: Vec<String>,
    pub cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    system_dark: bool,
    settings: lathe_core::settings::Snapshot,
    session: serde_json::Value,
    recent: Vec<String>,
    launch: Launch,
    data_dir: String,
    startup: Startup,
}

/// When start-up reached each step on the Rust side, in milliseconds since 1970, for the
/// "Developer: Startup performance" report (the page adds its own steps).
#[derive(Serialize)]
struct Startup {
    /// Windows created the process.
    process: f64,
    /// `main` began.
    main: f64,
    /// Settings and the last session are read; the window is created next.
    boot: f64,
}

static MAIN_AT: OnceLock<f64> = OnceLock::new();

/// Notes that `main` has begun (its first line calls this).
pub fn mark_main() {
    let _ = MAIN_AT.set(now_ms());
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// When Windows created this process (0 if it can't say).
fn process_started_ms() -> f64 {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut created = FILETIME::default();
    let (mut exited, mut kernel, mut user) = (created, created, created);
    // SAFETY: this process's pseudo-handle and four valid out-pointers.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if ok.is_err() {
        return 0.0;
    }
    // 100 ns ticks since 1601, to milliseconds since 1970.
    let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    ticks.saturating_sub(116_444_736_000_000_000) as f64 / 10_000.0
}

pub fn create_main(app: &AppHandle<Wry>, data_dir: &Path) -> Result<()> {
    // WebView2 adds its own `EBWebView` folder inside this one.
    let environment = webview2::create_environment(data_dir)?;
    webview2::clear_crash_reports(&environment);

    // Settings, the last session and the Windows theme are handed over before the page loads,
    // so the first frame already looks right.
    let state = app.state::<AppState>();
    let system_dark = theme::system_prefers_dark();
    let settings = state.user_settings.snapshot();
    let dark = match settings
        .values
        .get("workbench.theme")
        .and_then(|v| v.as_str())
    {
        Some("light") => false,
        Some("dark") => true,
        _ => system_dark,
    };
    let boot = Boot {
        system_dark,
        settings,
        session: state.session.load(),
        recent: state.session.recent_folders(),
        launch: Launch {
            args: std::env::args().skip(1).collect(),
            cwd: std::env::current_dir()
                .map(|d| d.display().to_string())
                .unwrap_or_default(),
        },
        data_dir: data_dir.display().to_string(),
        startup: Startup {
            process: process_started_ms(),
            main: MAIN_AT.get().copied().unwrap_or(0.0),
            boot: now_ms(),
        },
    };
    let boot = serde_json::to_string(&boot).unwrap_or_else(|_| "{}".into());

    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Lathe")
        .inner_size(1360.0, 860.0)
        .min_inner_size(640.0, 420.0)
        .decorations(false)
        .background_color(theme::background(dark))
        .visible(false)
        .incognito(true)
        .general_autofill_enabled(false)
        .zoom_hotkeys_enabled(false)
        .initialization_script(INIT_SCRIPT)
        .initialization_script(format!("window.__LATHE_BOOT__ = Object.freeze({boot});"))
        .on_navigation(crate::guard::allow_navigation)
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false)
        .with_environment(environment)
        .build()?;

    webview2::harden(&window)?;
    crate::caption::install(&window)?;

    let watched = window.clone();
    let minimized = AtomicBool::new(false);
    window.on_window_event(move |event| match event {
        // Minimized, WebView2 is asked to use less memory; restored, it works normally again.
        WindowEvent::Resized(_) => {
            let now = watched.is_minimized().unwrap_or(false);
            if minimized.swap(now, Ordering::SeqCst) != now {
                webview2::set_low_memory(&watched, now);
            }
        }
        // Files dropped from File Explorer open in Lathe (the page itself never sees paths).
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
            let paths: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
            let _ = watched.emit_to(MAIN, DROP_EVENT, paths);
        }
        _ => {}
    });

    show_if_ui_hangs(window);
    Ok(())
}

/// Brings the main window forward (a second launch of Lathe does this).
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Called by the UI once it has painted.
pub fn mark_ready() {
    READY.store(true, Ordering::SeqCst);
}

/// If the UI never says it's ready (a crash or a bug), show the window anyway so the app
/// doesn't keep running invisibly.
fn show_if_ui_hangs(window: WebviewWindow<Wry>) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        if !READY.load(Ordering::SeqCst) && !crate::guard::background_mode() {
            let _ = window.show();
        }
    });
}
