//! File commands: read and save text, list folders, create, rename, delete, copy and move,
//! show a file in File Explorer, and the native open/save dialogs.

use std::path::PathBuf;

use lathe_core::files::{self, Entry, OpenedText, Stamp, TextFormat};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::{WebviewWindow, Wry};

use crate::state::absolute;
use crate::{Error, Result};

/// File work runs on a blocking thread, so a slow disk never stalls the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| Error::Invalid(format!("The file task failed: {err}")))?
}

#[tauri::command]
pub async fn fs_read_text(path: String) -> Result<OpenedText> {
    let path = absolute(&path)?;
    blocking(move || Ok(files::read_text(&path)?)).await
}

#[tauri::command]
pub async fn fs_write_text(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
    text: String,
    format: Option<TextFormat>,
    expected: Option<Stamp>,
    force: bool,
) -> Result<Stamp> {
    let path = absolute(&path)?;
    let data_dir = state.data_dir.clone();
    blocking(move || {
        let format = format.unwrap_or_else(|| TextFormat::for_new_file(&path));
        let stamp = files::write_text(&path, &text, &format, expected, force)?;
        // Local history keeps each saved version; failing to keep one never fails the save.
        let _ = lathe_core::history::record(&data_dir, &path, &text);
        Ok(stamp)
    })
    .await
}

/// Earlier saved versions of a file, newest first.
#[tauri::command]
pub fn history_list(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
) -> Result<Vec<lathe_core::history::Entry>> {
    Ok(lathe_core::history::list(
        &state.data_dir,
        &absolute(&path)?,
    ))
}

#[tauri::command]
pub fn history_read(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
    id: String,
) -> Result<String> {
    Ok(lathe_core::history::read(
        &state.data_dir,
        &absolute(&path)?,
        &id,
    )?)
}

/// The format a new file at `path` would get (UTF-8, the neighbours' line endings).
#[tauri::command]
pub async fn fs_new_file_format(path: String) -> Result<TextFormat> {
    let path = absolute(&path)?;
    blocking(move || Ok(TextFormat::for_new_file(&path))).await
}

/// A file's raw bytes (images and other previews), without JSON encoding.
#[tauri::command]
pub async fn fs_read_bytes(path: String) -> Result<Response> {
    let path = absolute(&path)?;
    blocking(move || {
        let meta = std::fs::metadata(&path)?;
        if meta.len() > files::MAX_TEXT_BYTES {
            return Err(Error::Invalid("The file is too big to preview.".into()));
        }
        Ok(Response::new(std::fs::read(&path)?))
    })
    .await
}

#[tauri::command]
pub async fn fs_read_dir(path: String) -> Result<Vec<Entry>> {
    let path = absolute(&path)?;
    blocking(move || Ok(files::read_dir(&path)?)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatInfo {
    dir: bool,
    size: u64,
    mtime: i64,
    read_only: bool,
}

/// What's at `path`, or `null` if nothing is.
#[tauri::command]
pub async fn fs_stat(path: String) -> Result<Option<StatInfo>> {
    let path = absolute(&path)?;
    blocking(move || {
        Ok(std::fs::metadata(&path).ok().map(|meta| {
            let stamp = Stamp::of(&path).unwrap_or(Stamp { mtime: 0, size: 0 });
            StatInfo {
                dir: meta.is_dir(),
                size: meta.len(),
                mtime: stamp.mtime,
                read_only: meta.permissions().readonly(),
            }
        }))
    })
    .await
}

#[tauri::command]
pub async fn fs_create_file(path: String) -> Result<()> {
    let path = absolute(&path)?;
    blocking(move || Ok(files::create_file(&path)?)).await
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<()> {
    let path = absolute(&path)?;
    blocking(move || Ok(files::create_dir(&path)?)).await
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<()> {
    let (from, to) = (absolute(&from)?, absolute(&to)?);
    blocking(move || Ok(files::rename(&from, &to)?)).await
}

#[tauri::command]
pub async fn fs_delete(paths: Vec<String>, to_trash: bool) -> Result<()> {
    let paths = paths
        .iter()
        .map(|p| absolute(p))
        .collect::<Result<Vec<PathBuf>>>()?;
    blocking(move || Ok(files::delete(&paths, to_trash)?)).await
}

#[tauri::command]
pub async fn fs_copy_into(sources: Vec<String>, target_dir: String) -> Result<Vec<String>> {
    let sources = sources
        .iter()
        .map(|p| absolute(p))
        .collect::<Result<Vec<PathBuf>>>()?;
    let target = absolute(&target_dir)?;
    blocking(move || {
        Ok(files::copy_into(&sources, &target)?
            .into_iter()
            .map(|p| p.display().to_string())
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn fs_move_into(sources: Vec<String>, target_dir: String) -> Result<Vec<String>> {
    let sources = sources
        .iter()
        .map(|p| absolute(p))
        .collect::<Result<Vec<PathBuf>>>()?;
    let target = absolute(&target_dir)?;
    blocking(move || {
        Ok(files::move_into(&sources, &target)?
            .into_iter()
            .map(|p| p.display().to_string())
            .collect())
    })
    .await
}

/// Opens File Explorer with `path` selected.
#[tauri::command]
pub async fn fs_reveal(path: String) -> Result<()> {
    let path = absolute(&path)?;
    blocking(move || crate::explorer::reveal(&path)).await
}

#[tauri::command]
pub async fn dialog_pick_folder(window: WebviewWindow<Wry>) -> Result<Option<String>> {
    // Tests answer the picker; several folders (separated by ;) answer successive picks, the
    // last one from then on.
    if let Some(paths) = crate::guard::test_value("LATHE_TEST_PICK_FOLDER") {
        static PICKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let list: Vec<&str> = paths.split(';').filter(|p| !p.is_empty()).collect();
        let at = PICKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return Ok(list.get(at).or(list.last()).map(|p| p.to_string()));
    }
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Open folder")
        .set_parent(&window)
        .pick_folder()
        .await;
    Ok(picked.map(|handle| handle.path().display().to_string()))
}

#[tauri::command]
pub async fn dialog_pick_files(window: WebviewWindow<Wry>) -> Result<Vec<String>> {
    if let Some(path) = crate::guard::test_value("LATHE_TEST_PICK_FILE") {
        return Ok(vec![path]);
    }
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Open file")
        .set_parent(&window)
        .pick_files()
        .await;
    Ok(picked
        .unwrap_or_default()
        .iter()
        .map(|handle| handle.path().display().to_string())
        .collect())
}

#[tauri::command]
pub async fn dialog_save_as(
    window: WebviewWindow<Wry>,
    default_path: Option<String>,
) -> Result<Option<String>> {
    if let Some(path) = crate::guard::test_value("LATHE_TEST_SAVE_PATH") {
        return Ok(Some(path));
    }
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Save as")
        .set_parent(&window);
    if let Some(default) = default_path.map(PathBuf::from) {
        if let Some(dir) = default.parent().filter(|d| d.is_dir()) {
            dialog = dialog.set_directory(dir);
        }
        if let Some(name) = default.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
    }
    let picked = dialog.save_file().await;
    Ok(picked.map(|handle| handle.path().display().to_string()))
}
