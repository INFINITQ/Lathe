# Architecture

Lathe is a Tauri 2 app: a React UI in WebView2 and a Rust process that does the real work. The
decisions behind this shape are in [adr/](adr/README.md); Windows traps are in
[build-notes.md](build-notes.md).

## Processes

```
lathe.exe (Rust)                                WebView2 (React UI)
├─ apps/lathe/src-tauri   thin shell:           ├─ src/lib/backend.ts  the only module that
│   window, commands, Channels, protocols      │   talks to Tauri (fakeBackend() in tests)
└─ crates/lathe-core      the engine:           ├─ src/workbench/      title bar, rail, views,
    proc, terminal, text, files, search,        │   editor groups, panel, status bar
    git, lsp, dap, kernels, toolchains,         ├─ src/editor/         CodeMirror setup, theme,
    settings, session, plugins                  │   keymap, LSP bridge, gutters
                                                └─ src/services/       commands, keybindings,
child processes (each in its own Job Object):       settings, documents, lsp, debug, ...
  shells (ConPTY), compilers and programs (Run),
  language servers, debug adapters, Jupyter kernels, git
```

## Rules

- **`lathe-core` has no Tauri dependency.** It is tested directly with `cargo test`. The
  shell wraps it in commands and passes it sinks for streaming.
- **Every child process goes through `lathe_core::proc`.** Clippy enforces this. Each child
  gets a Job Object, `CREATE_NO_WINDOW`, and starts suspended so its whole tree can be killed.
- **The UI never touches the network** ([ADR 0002](adr/0002-ui-never-touches-the-network.md)).
- **CodeMirror owns the editor DOM.** React mounts a host element once, so typing never
  re-renders React.
- **Untrusted content runs on its own origin:**
  - plugins on `lathe-plugin://`, in Workers inside a hidden frame;
  - notebook HTML on `lathe-output://`, in sandboxed iframes.

  Neither origin has any Tauri capability.

## IPC

- **Commands** (`invoke`) for request/response. Errors come back as `{ kind, message }`, and
  file contents travel as raw bytes (`tauri::ipc::Response`), not JSON.
- **Channels** for streams. Tauri sends small payloads through `eval` and big ones through a
  fetch, so senders batch:
  - terminal output in frames of ≤ 16 ms or ≤ 64 KB;
  - LSP/DAP/kernel messages per tick, as a JSON array;
  - search and file-finder results about every 50 ms.
- **Events** only for rare global signals: settings or theme changed, a second launch's
  arguments.
- **Boot data:** `window.__LATHE_BOOT__` carries the theme and the last session, so the first
  frame is already right.

## Data

`%LOCALAPPDATA%\app.lathe\`:

- `settings.json`, `keybindings.json` (both VS Code's format), `session.json`;
- `snippets\` for your own snippets (`<language>.json`, `*.code-snippets`);
- `plugins\<id>\` for installed plugins;
- `tools\<name>\<version>\` for downloaded language servers and debug adapters;
- `history\` for local file history;
- `EBWebView\`, WebView2's profile.

A workspace's own settings live in `.lathe/` in the folder.

## Command line and installer

- `bin\lathe.cmd` (and `bin\lathe` for Git Bash) run `lathe.exe --cli …`. That process never
  shows a window: it starts `lathe.exe` with the arguments, detached (a running Lathe takes them
  over through the single-instance plugin), and exits. With `--wait` it passes
  `--wait-marker=<file in %TEMP%>` along and waits until the Lathe window creates that file,
  which it does when the last of those editors closes or when it quits (`src-tauri/src/cli.rs`).
- The NSIS installer is per-user. Its hooks (`src-tauri/installer-hooks.nsh`) add "Open with
  Lathe" verbs, `OpenWithProgids` entries and Default Apps capabilities (never a file type's
  default), and put `bin` on the user PATH with `bin\lathe-path.ps1`, which keeps the PATH's
  `REG_EXPAND_SZ` form. The uninstaller removes exactly what was added.
