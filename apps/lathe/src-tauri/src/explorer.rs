//! Showing a file in File Explorer, through the shell rather than by starting `explorer.exe`
//! (which would join Lathe's process tree).

use std::path::Path;

use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
use windows::core::HSTRING;

use crate::{Error, Result};

/// Opens a File Explorer window on `path`'s folder with `path` selected.
pub fn reveal(path: &Path) -> Result<()> {
    if let Some(log) = crate::guard::test_links_file() {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)?;
        writeln!(file, "reveal {}", path.display())?;
        return Ok(());
    }
    let wide = HSTRING::from(path.as_os_str());
    let shown = std::thread::spawn(move || {
        // SAFETY: COM is set up and released on this thread only; the item list is freed.
        unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            let item = ILCreateFromPathW(&wide);
            let result = if item.is_null() {
                false
            } else {
                let shown = SHOpenFolderAndSelectItems(item, None, 0).is_ok();
                ILFree(Some(item));
                shown
            };
            if com.is_ok() {
                CoUninitialize();
            }
            result
        }
    })
    .join()
    .unwrap_or(false);
    if shown {
        Ok(())
    } else {
        Err(Error::Invalid(
            "File Explorer couldn't show that file.".into(),
        ))
    }
}
