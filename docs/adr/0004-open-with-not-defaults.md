# 0004. The installer offers Lathe for code files but never makes it their default

- Status: accepted
- Date: 2026-11-04

## Context

Tauri's `bundle.fileAssociations` registers each extension with the app's own file type as the
extension's default (`HKCU\Software\Classes\.py` → the app). That suits a document viewer, and
Folio uses it. For a code editor it would change what double-clicking a script does: `.py` would
stop running with Python, `.ps1` and `.bat` would stop doing what they do, for anyone without
an explicit choice in Settings.

`lathe --wait` (Git's editor) has a similar question: the process Git waits on can't be the
Lathe window, because the window has to keep running for other files and folders.

## Decision

- No `fileAssociations`. The installer's hooks (`apps/lathe/src-tauri/installer-hooks.nsh`)
  register a `Lathe.File` type, add it to each code extension's `OpenWithProgids` (so Lathe is
  in "Open with"), list the extensions under Lathe's `Capabilities` for Settings › Default apps,
  and add "Open with Lathe" verbs for files, folders and folder backgrounds. Windows leaves the
  choice of default to the user, as it intends.
- Everything is per-user, and the uninstaller removes only the values it added (other apps'
  `OpenWithProgids` entries stay).
- `lathe` is a command-line front (`lathe.exe --cli`, started by `bin\lathe.cmd`) that never
  shows a window. It starts the window detached and, with `--wait`, waits for a marker file the
  window makes when the file's editors close (or when it quits). A missing window with no marker
  means Lathe crashed, and the command fails so Git doesn't commit an unfinished message.

## Consequences

- Double-clicking a code file still does what it did; opening it in Lathe is one menu away, or
  a choice in Settings › Default apps.
- The new Windows 11 context menu needs a signed app package, so "Open with Lathe" sits under
  "Show more options" until Lathe ships one.
- The PATH change goes through PowerShell (`bin\lathe-path.ps1`) rather than NSIS string code,
  which is limited to 1024 characters and would cut a long PATH.
