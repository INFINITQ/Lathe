//! `lathe` on the command line. `bin\lathe.cmd` (and `bin\lathe` for Git Bash) run
//! `lathe.exe --cli …`; that process never shows a window. It starts Lathe with the arguments (a
//! Lathe that's already running takes them over) and returns at once, or, with `--wait`, when
//! you've closed the files it opened, so Lathe can be Git's editor:
//! `git config --global core.editor "lathe --wait"`.
//!
//! Waiting works through a marker file in %TEMP%: the CLI passes `--wait-marker=<file>` along,
//! and the Lathe window creates that file when the last of those editors closes (or when it
//! quits).

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
use windows::core::w;

use crate::{Error, Result};

const MARKER_ARG: &str = "--wait-marker=";
const MARKER_PREFIX: &str = "lathe-wait-";

/// Runs the command-line side when started with `--cli`, returning the exit code; `None` means
/// this is an ordinary start of the app.
pub fn run_if_cli() -> Option<i32> {
    let mut args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_none_or(|first| first != "--cli") {
        return None;
    }
    args.remove(0);
    let wait = args.iter().any(|a| a == "--wait" || a == "-w");
    args.retain(|a| a != "--wait" && a != "-w");
    let marker = wait.then(new_marker);
    if let Some(marker) = &marker {
        let _ = std::fs::remove_file(marker);
        let mut arg = OsString::from(MARKER_ARG);
        arg.push(marker);
        args.push(arg);
    }
    let (Ok(exe), Ok(cwd)) = (std::env::current_exe(), std::env::current_dir()) else {
        return Some(1);
    };
    if lathe_core::proc::spawn_detached(&exe, &args, &cwd).is_err() {
        return Some(1);
    }
    Some(match marker {
        Some(marker) => wait_for(&marker),
        None => 0,
    })
}

fn new_marker() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("{MARKER_PREFIX}{}-{nanos}", std::process::id()))
}

/// Whether a Lathe window is running: the single-instance plugin holds a mutex named after the
/// app's identifier ("app.lathe") while it runs.
fn lathe_running() -> bool {
    // SAFETY: plain Win32 call with a static, NUL-terminated name; the handle is closed at once.
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, w!("app.lathe-sim")) } {
        Ok(handle) => {
            // SAFETY: the handle was just opened.
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

/// Waits for the marker. 0 once it's there; 1 if Lathe went away without making it (a crash),
/// so Git doesn't go on with a message you never finished.
fn wait_for(marker: &Path) -> i32 {
    let started = Instant::now();
    let mut seen = false;
    loop {
        if marker.exists() {
            let _ = std::fs::remove_file(marker);
            return 0;
        }
        if lathe_running() {
            seen = true;
        } else if seen || started.elapsed() > Duration::from_secs(60) {
            // One more look: Lathe makes the marker just before it quits.
            std::thread::sleep(Duration::from_millis(200));
            let done = marker.exists();
            let _ = std::fs::remove_file(marker);
            return if done { 0 } else { 1 };
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// A marker the CLI could have made: `%TEMP%\lathe-wait-<digits and dashes>`. Anything else is
/// refused, so a launch argument can't make Lathe write a file somewhere else.
fn valid_marker(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    let name = path.file_name()?.to_str()?;
    let rest = name.strip_prefix(MARKER_PREFIX)?;
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return None;
    }
    let parent = dunce::canonicalize(path.parent()?).ok()?;
    let temp = dunce::canonicalize(std::env::temp_dir()).ok()?;
    (parent == temp).then_some(path)
}

/// Markers of `--wait` launches still waiting for their editors to close.
#[derive(Default)]
pub struct Waits(Mutex<HashSet<PathBuf>>);

impl Waits {
    /// Notes the marker of a launch, if it has one.
    pub fn register(&self, args: &[String]) {
        for arg in args {
            if let Some(marker) = arg.strip_prefix(MARKER_ARG).and_then(valid_marker) {
                self.0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(marker);
            }
        }
    }

    /// Lets the waiting `lathe --wait` go.
    pub fn release(&self, marker: &str) -> Result<()> {
        let path =
            valid_marker(marker).ok_or_else(|| Error::Invalid("Not a wait marker.".into()))?;
        let known = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&path);
        if !known {
            return Err(Error::Invalid("Nothing is waiting on that marker.".into()));
        }
        std::fs::write(&path, b"")?;
        Ok(())
    }

    /// Lets every waiting `lathe --wait` go (Lathe is quitting).
    pub fn release_all(&self) {
        let markers: Vec<PathBuf> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        for marker in markers {
            let _ = std::fs::write(&marker, b"");
        }
    }
}

#[tauri::command]
pub fn wait_release(waits: tauri::State<'_, Waits>, marker: String) -> Result<()> {
    waits.release(&marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_markers_in_the_temp_folder_are_accepted() {
        let temp = std::env::temp_dir();
        let good = temp.join("lathe-wait-123-456");
        assert_eq!(valid_marker(&good.display().to_string()), Some(good));
        assert_eq!(
            valid_marker(&temp.join("lathe-wait-").display().to_string()),
            None
        );
        assert_eq!(
            valid_marker(&temp.join("lathe-wait-1x").display().to_string()),
            None
        );
        assert_eq!(
            valid_marker(&temp.join("other-123").display().to_string()),
            None
        );
        assert_eq!(valid_marker(r"C:\Windows\lathe-wait-1"), None);
        let nested = temp.join("sub").join("lathe-wait-1");
        assert_eq!(valid_marker(&nested.display().to_string()), None);
    }

    #[test]
    fn a_registered_marker_is_released_once() {
        let marker = std::env::temp_dir().join(format!("lathe-wait-{}-1", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let waits = Waits::default();
        waits.register(&[
            "file.txt".into(),
            format!("{MARKER_ARG}{}", marker.display()),
            format!("{MARKER_ARG}C:\\Windows\\lathe-wait-2"),
        ]);
        assert!(waits.release(r"C:\Windows\lathe-wait-2").is_err());
        waits.release(&marker.display().to_string()).unwrap();
        assert!(marker.exists());
        assert!(waits.release(&marker.display().to_string()).is_err());
        std::fs::remove_file(&marker).unwrap();
    }
}
