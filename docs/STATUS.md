# Status

Updated at the end of every milestone. Each milestone ends with a runnable app, a green
`pnpm verify` and a screenshot.

| Milestone                         | State |
| --------------------------------- | ----- |
| M0 Foundations and risk spikes    | done  |
| M1 Workbench, editor, files       | done  |
| M2 Terminal, toolchains, Run      | done  |
| M3 Search and navigation          | done  |
| M4 Code intelligence (LSP)        | done  |
| M5 Source control (Git)           | done  |
| M6 Debugger (DAP)                 | done  |
| M7 Notebooks                      | done  |
| M8 Plugin system                  | done  |
| M9 Settings UI, polish, packaging | done  |
| Speed pass                        | done  |

## M0

- [x] Workspaces (pnpm, Cargo), lint, format, test and supply-chain config, copied from Hearth.
- [x] Core modules ported from Hearth: `proc`, `exec`, `shell`, `terminal`, `text`, `paths`,
      `fsutil`.
- [x] Tauri shell: frameless window hidden until painted, WebView2 hardening, Snap Layouts,
      strict CSP with frozen prototypes.
- [x] Mono design tokens (dark and light), title bar, activity rail, status bar, a CodeMirror
      editor.
- [x] Spike 1: CodeMirror under the CSP and `freezePrototype` (e2e `smoke.spec.ts`; the
      editor has run under them since M1).
- [x] Spike 2: LSP round trip through Rust framing and `@codemirror/lsp-client` (M4; the live
      basedpyright and clangd tests).
- [x] Spike 3: Jupyter `execute_request` round trip and interrupt on Windows
      ([spikes/jupyter.md](spikes/jupyter.md); M7's live notebook tests).
- [x] Spike 4: debugpy breakpoint; C++ (MSVC) breakpoint through CodeLLDB
      ([spikes/dap.md](spikes/dap.md); M6's live debugger tests).
- [x] Spike 5: a worker on a separate origin can't reach Tauri or the network (M8: plugins run
      that way, and `e2e/plugins.spec.ts` checks a plugin can't read files without permission).

## M1 (done)

Done so far:

- Rust (`lathe-core`): `files` (encoding-preserving read and save via `ReplaceFileW`, conflict
  detection, folder listing, create/rename/delete to the Recycle Bin/copy/move), `jsonc`,
  `settings` (never overwrites a damaged file), `session` (session.json, unsaved-buffer
  backups, recent folders), `workspace` (watcher with debouncing, gitignore-aware file index,
  fuzzy quick open with nucleo). 43 tests pass.
- Tauri commands: `fs_*`, `dialog_*`, `workspace_*`, `settings_*`, `session_save`,
  `buffer_*`, `recent_*`, `window_set_title`. Boot data carries settings, session, recent
  folders and launch arguments. Second launches and Explorer drops become events.
- UI services: `lib/backend.ts` (full contract, plus a fake backend with a demo project),
  `lib/paths.ts`, `services/{commands,when,context,keybindings,settings,notifications,dialogs}.ts`.
- Editor: `documents.ts` (shared docs, split-view sync, save with conflict, read-only and
  disk-change handling), `languages.ts`, `setup.ts` (settings compartments), `keymap.ts`,
  `active.ts`; `workbench/editors/store.ts` (groups, tabs, previews, pinning, splits, moves).
- **Workbench:**
  - title bar (app menu, folder switcher, command centre), activity rail (theme and accent menu);
  - explorer: virtual tree with rename, new, delete, cut, copy, paste and drag-move, a context
    menu, and auto-reveal;
  - editor groups: tabs, previews, pins, dragging between groups, splits, breadcrumbs, image
    viewer, welcome page;
  - quick input: files via Rust, `>` commands, `:` line, pickers;
  - status bar: language, encoding, line endings and indentation pickers;
  - panel shell, toasts and dialogs.
- **Commands and keys:** `workbench/commands.ts` holds the commands and the VS Code-style default
  keybindings, chords included.
- **Session:** `services/session.ts` handles hot exit and session restore; `App.tsx` and
  `main.tsx` do the wiring.
- **Tests:**
  - 12 Vitest tests.
  - `e2e/smoke.spec.ts`, 4 tests, all passing: workbench, palette, folder → quick open → CRLF/BOM
    save → split sync, and a restart that brings back unsaved text.
  - `e2e/budgets.spec.ts` is written but not run yet.

Still to do in M1:

- Integrate `editor/minimap.ts` and `editor/find.ts` (a background helper is writing them) through
  `addEditorExtensions` in `setup.ts` and the `editor.minimap.enabled` setting.
- Run the budgets spec, and add Emmet (`@emmetio/codemirror6-plugin`).
- Send you a screenshot, run `pnpm verify`, then mark M1 done.

Spike results (`docs/spikes/`):

- `dap.md`: debugpy, js-debug and CodeLLDB all work.
- `jupyter.md`: jupyter-zmq-client works.
- LSP: the spike helper was blocked by auto mode, so M4 verifies it directly.
- Plugin origin isolation (spike 5): moved to the start of M8.

M1 finished with the minimap and find widget wired in (`editor/minimap.ts`, `editor/find.ts`, 34
unit tests). Debug-build budgets: startup 433–652 ms, 99–102 MB idle, quick open 84 ms over 20k
files, a 10 MB file opens in 310 ms, keystrokes take 1.7–2.2 ms (median). Screenshots are in
`docs/screenshots/m1-{dark,light}.png`.

## M2 (done)

- **`lathe-core`:**
  - `terminal::profiles`: PowerShell, Command Prompt, Git Bash, and WSL when a distro is installed.
  - `terminal::Launch::program` runs a program in a terminal (Run, tasks, winget installs).
  - `run::{capture, which}`: compile steps with a timeout; Store aliases are skipped.
  - `toolchains`: detection of 16 toolchains; the MSVC developer environment is cached in the data
    folder; PATH is refreshed from the registry; winget arguments.
- **Tauri:** `terminal_commands.rs` (profiles, open, run, attach, write, resize, close, list) and
  `toolchain_commands.rs` (detect, MSVC env, PATH refresh, which, capture, winget args, trust).
- **Terminal panel** (`workbench/terminal/`):
  - xterm 6 with fit, search, unicode11 and web-links; `file:line` and `file(line,col)` links
    open in the editor; keys go to the shell except `TERMINAL_KEYS`.
  - `store.ts` holds each terminal's single connection (`watchTerminal`, `terminalExited`), so
    exits, output and problem matching keep working while the panel is hidden. A view that opens
    later replays the last 1 MB.
- **Run** (`run/run.ts`; ▶ in the tab strip, Ctrl+F5, and the Run and debug view):
  - Python, Node (JS, and TS through type stripping), Java (single file), Go, `dotnet run`,
    Ruby, PHP, Lua, PowerShell, Bash, Rust (`cargo run` in a Cargo project, otherwise `rustc`),
    and C/C++ (clang++, then g++, then MSVC `cl` with the cached VsDevCmd environment).
  - Builds go to `<dataDir>\run\<folder>-<hash>`, so two `main.cpp` files never collide.
  - Compile errors go to Problems; build output goes to the Output panel's Run channel.
  - A workspace trust prompt appears before the first run in a folder.
- **Tasks** (`run/tasks.ts`):
  - Sources: `.lathe/tasks.json`, `.vscode/tasks.json` (shell, process, npm, cargo and typescript
    types; `windows` overrides; `options.cwd/env/shell`; `dependsOn`, run in order), package.json
    scripts (pnpm/yarn/bun from the lockfile) and Cargo commands.
  - VS Code's variables (`${workspaceFolder}`, `${file}`…, `${env:X}` in the shell's own syntax).
  - Shell tasks run in pwsh, or else Windows PowerShell, through `-EncodedCommand`.
  - Commands: Run task, Run build task (Ctrl+Shift+B), Run test task, Rerun last task, Configure
    tasks (writes a template).
  - A task with a problem matcher reports compiler errors when it ends.
- **Problems panel and status bar counts.** The parser reads gcc/clang, MSVC/C#, rustc, javac,
  tsc (plain and pretty), go and ESLint stylish, ignoring terminal escapes (`lib/ansi.ts`).
- **Other:** `lib/jsonc.ts`. The fuzzy matcher no longer jumps to a word start that leaves the
  rest of the query unmatched (that broke "report" against "report a problem").
- **Tests:**
  - `e2e/run.spec.ts` covers:
    - hello-world programs reading input in Python, JS, TS, C++ (MSVC), Java and Rust;
    - an MSVC error in Problems;
    - Ctrl+Shift+B with a JSONC tasks.json;
    - a task's problem matcher;
    - a PowerShell terminal.
  - Vitest covers problems, tasks, jsonc, ansi and fuzzy.
- Screenshots: `docs/screenshots/m2-{dark,light}.png`.

## M3 (done)

- **`lathe_core::search`:**
  - The walk runs in parallel and honours .gitignore (`ignore`, `grep-searcher`, `grep-regex`).
    Results go out in batches: the first at once, then at most every 40 ms.
  - Open files with unsaved changes are searched from the editor's text, not from disk.
  - UTF-16 files are read through BOM sniffing; binary files are skipped.
  - Columns are UTF-16 offsets, and CRLF lines report the same columns as LF ones; long lines
    get a preview window around the match.
  - Include and exclude globs work as in VS Code (`src`, `./docs/**`, `*.ts`).
  - A match limit, and cancellation per slot: "view" for the Search view, "symbols" for `#`.
  - Sharing violations are retried, and files or folders that can't be read are reported rather
    than dropped.
  - Replacing keeps each file's encoding, BOM and line endings. It takes VS Code's syntax
    (`$1 $& $$ $<name> \n \t \u \l \U \L \E`) and returns UTF-16 edits for open documents.
  - 9 tests, plus an ignored 20,000-file stress test.
- **Tauri:** `search_commands.rs` provides `search_start(query, unsaved, slot, channel)`,
  `search_cancel`, `search_replace_files`, `search_replace_at` and `search_edits`.
- **Search view** (Ctrl+Shift+F, Ctrl+Shift+H):
  - Case, whole-word and regex toggles (Alt+C, Alt+W, Alt+R); include and exclude fields; and
    an exclude-settings toggle (`files.exclude`, `search.exclude`, .gitignore).
  - Search as you type (300 ms) and a virtual results tree.
  - An inline replace preview, with replace all, replace in a file, and replace one match.
  - Dismiss, collapse all, F4 and Shift+F4 to step through results, and "Find in folder…" in
    the Explorer.
  - Replace all saves open files that had no unsaved changes; files with unsaved changes get
    the edit in memory.
- **Symbols** (`editor/symbols.ts`, from Lezer trees for JS/TS, Python, Rust, C/C++, Java, Go,
  JSON, CSS and Markdown):
  - `@` in quick open (Ctrl+Shift+O).
  - `#` (Ctrl+T): definition keywords found by the search engine, until LSP arrives in M4.
  - An Outline section under the Explorer.
  - The breadcrumbs' symbol path.
  - Sticky scroll (`editor.stickyScroll.enabled`).
- **Navigation:** Alt+← and Alt+→, and the mouse's side buttons (`services/navigation.ts`).
- **Fixes:**
  - Opening a file "at a line" when its tab is already on screen now moves the cursor
    (`selectionRequest`).
  - `OpenOptions` gained range selections and `preserveFocus`.
- **Budgets (debug build):** the first search result in 34 ms, and a whole search over 20,000
  files plus a 10 MB file in 191 ms. Defender's first-open scan is in build-notes.
- **Tests:** `e2e/search.spec.ts` (5 tests) covers:
  - unsaved text;
  - ignored files;
  - replace all keeping CRLF, the BOM and UTF-16;
  - `@` with Alt+←/→, and `#`;
  - the outline, breadcrumbs and sticky scroll.
- Screenshots: `docs/screenshots/m3-{dark,light}.png`.

## M4 (done)

- **`lathe_core::lsp`:** servers are child processes in a job object. Messages use
  `Content-Length` framing (any header case, byte counts, a size cap); stderr becomes log
  lines, and the exit is reported. 4 tests, one with a real process.
- **`lathe_core::tools`:** downloads use Windows' `curl.exe` over HTTPS only (redirects too). A
  pinned SHA-256 is checked before anything else, and a mismatching file is deleted. `tar.exe`
  unpacks into a staging folder that replaces the old one. 3 tests.
- **Tauri:** `lsp_commands.rs` provides `lsp_start/send/stop`, `tools_dir` (or
  `LATHE_TEST_TOOLS_DIR` in debug builds) and `tools_install_archive`.
- **`crates/lathe-testkit` `fake-lsp`:** a fake server for `.fake` files covering:
  - diagnostics (FIXME, ERROR) and a quick fix;
  - completion, hover, definition, references, rename (as `documentChanges` across files);
  - formatting, symbols, highlights, signature help, inlay hints;
  - a `workspace/configuration` request, and a crash on `CRASH_NOW`.
    `build:e2e` builds it.
- **UI (`src/lsp/`):**
  - `servers.ts`, the registry:
    - basedpyright 1.40.2 and TypeScript 7.0.2 (`tsc --lsp`), installed with npm into the
      tools folder;
    - clangd 23.1.0 (a pinned download);
    - rust-analyzer (`rustup component add`);
    - JSON, CSS and HTML (vscode-langservers-extracted 4.10.0) and YAML 2.0.0;
    - gopls and jdtls from PATH;
    - your own servers in `lsp.servers` (these need workspace trust).
  - `server.ts`, the session layer:
    - it answers `workspace/configuration`, `applyEdit`, `showMessageRequest`, `showDocument`
      and `workspaceFolders`, plus `registerCapability` and the refresh requests;
    - it adds `workspaceFolders` and `clientInfo` to `initialize`;
    - diagnostics go to Problems and squiggles, logs and `window/logMessage` to an Output
      channel per server, and `$/progress` to the status bar;
    - it sends `didSave` and `didChangeWatchedFiles`, and pulls diagnostics (LSP 3.17) for
      servers that don't publish them (TypeScript 7);
    - a crashed server restarts with backoff (4 times in 3 minutes);
    - `lsp.trace: "messages"` logs all traffic.
  - `workspace.ts`: one file per document across split editors. A file stays open in the
    server while its tab exists, even off screen (pyright only renames across open files), and
    background tabs that change are synced too.
  - `edits.ts`, the workspace edits:
    - open documents change in memory;
    - other files are loaded, changed and saved in their own format;
    - files that had no unsaved changes are saved afterwards, as with VS Code's refactoring
      auto-save;
    - create, rename and delete file operations are supported.
  - `features.ts`:
    - quick fixes (Ctrl+.), with resolve and commands;
    - rename (F2) with prepareRename, through a new quick input text mode;
    - inlay hints and server highlights;
    - Ctrl+click to a definition, and formatting on save;
    - Mono styles for hover, signature, references and diagnostics.
  - `manager.ts`:
    - starts servers lazily per folder and attaches them to editors (`compartments.lsp`);
    - offers each install once, with "Don't ask again";
    - commands to restart, stop, show output and install;
    - workspace symbols for `#` from running servers.
- **Commands:**
  - F12, Ctrl+F12 and Shift+F12; go to declaration and type definition;
  - F2, Ctrl+., Shift+Alt+F and Ctrl+Shift+Space.
  - These are workbench commands with `editorTextFocus`.
- **Status bar:** the server's state and progress, with a menu. The Output panel gained a
  channel picker and a clear button.
- **Tests:**
  - `e2e/lsp.spec.ts` (7 tests, fake server): diagnostics, the server's own request, hover,
    completion, F12 across files, a rename across files saved to disk, a quick fix,
    formatting, and a crash with restart.
  - `e2e/live-lsp.spec.ts` (opt-in, `LATHE_LIVE=1`): installs real basedpyright and clangd
    through Lathe's prompts, then checks diagnostics, completion, F12, a rename across two
    files, clangd's diagnostics, and TypeScript 7's diagnostics.
- Screenshots: `docs/screenshots/m4-{dark,light}.png`.

## M5 (done)

- **`lathe_core::git`** (the git CLI through `proc`, with no terminal prompts; Git Credential
  Manager handles sign-in):
  - status in porcelain v2, including renames and conflicts;
  - `show` at a revision or the index, decoded and LF-normalized, with its format;
  - stage, unstage (also before the first commit) and discard;
  - **`set_index`**: exact index contents through `hash-object` and `update-index`, which
    stages one hunk without patches and keeps CRLF;
  - commit and amend; branches, switch, create and delete;
  - fetch, pull and push, limited to the UI's own options;
  - log with `--follow`, and blame of the unsaved text;
  - stash, init, clone and identity.
  - 4 tests on real repositories.
- **`lathe_core::history`:** each save keeps a copy (up to 50 per file, 30 days, repeats
  skipped), recorded by `fs_write_text`. 2 tests.
- **Tauri:** `git_commands.rs` has 17 commands; `history_list` and `history_read`.
- **UI:**
  - `services/git.ts`: the store refreshes on folder changes, disk changes (including `.git`),
    saves and window focus, and holds the operations. A `gitRepo` context key enables the Git
    commands.
  - **Source control view:**
    - a commit box with Ctrl+Enter, an amend toggle, and "Stage all and commit?" when nothing
      is staged;
    - Merge, Staged and Changes groups with per-file and group actions;
    - click for a diff, double-click to open the file;
    - a menu for pull, push, fetch, sync, branches, stash and Git output;
    - "Initialize repository" when the folder has none.
  - **Diff editor** (a new `diff` tab, from `@codemirror/merge`):
    - side by side or inline, with previous and next change;
    - the working side is the live document, editable and in step with other editors;
    - it reloads when the index or HEAD moves;
    - it compares Git revisions or local history entries.
  - **Gutter bars** against the index: added, changed, deleted. Clicking one opens a peek of
    the old lines with Revert and Stage hunk.
  - **Status bar:** the branch (a picker to switch or create, including from remote branches)
    and sync with ahead and behind counts.
  - **Explorer:** files are coloured with a status letter, and folders with changes inside get
    a dot.
  - **Merge conflicts:** tinted blocks with Accept current, Accept incoming and Accept both.
  - **Inline blame** (`git.blame.inline`, "Toggle line blame"), file history, and "Compare with
    an earlier save" from local history.
- **Fixed:** a diff chunk's end can be one past the end of the document. Mapping it threw and
  dropped keystrokes until it was clamped.
- **Tests:** `e2e/git.spec.ts` (6 tests) covers:
  - the gutter bar and Explorer letter;
  - staging one hunk from the peek, then a Ctrl+Enter commit, checked with git;
  - creating a branch from the status bar;
  - the diff editor for an outside change;
  - the conflict buttons;
  - local history.
- Screenshots: `docs/screenshots/m5-{dark,light}.png`.

## M6 (done)

- **`lathe_core::dap`:** the three transports from the spike.
  - DAP over an adapter's stdio reuses `lsp::Server`.
  - A TCP connection to an adapter's server; js-debug's child sessions open a second one.
  - A port Lathe opens for an adapter to connect back to (CodeLLDB's `--connect`).
  - Adapter servers that don't speak on stdio still get their output logged and their exit
    reported. 2 tests.
- **Tauri:** `debug_commands.rs` has `dap_spawn`, `dap_connect`, `dap_listen`, `dap_accept`,
  `dap_send` and `dap_close`. Every adapter runs in a Job Object.
- **Adapters** (`debug/adapters.ts`), pinned downloads checked by SHA-256 into the tools folder,
  each offered (with its size) the first time it's needed:
  - debugpy 1.8.22 for Python, run isolated with your interpreter (the folder's `.venv` first;
    PyManager's launcher is resolved to the real `python.exe`);
  - js-debug 1.140.0 for JavaScript and TypeScript (Node's type stripping);
  - CodeLLDB 1.12.3 for C, C++ and Rust, which also reads `cppdbg`/`cppvsdbg` configurations;
  - your own adapters under `debug.adapters` in settings (stdio, trusted folders only).
- **Sessions** (`debug/session.ts`, `debug/manager.ts`):
  - responses matched on `request_seq`; the adapters' start-up order (launch answered last);
  - `runInTerminal` runs the program in a Lathe terminal, so `input()` and `cin` work;
  - js-debug's `startDebugging` child sessions show under their parent;
  - several sessions and threads, stop, restart (rebuilding the file first) and
    `preLaunchTask`;
  - workspace trust before anything runs, and dirty files saved first.
- **Launch configurations:** `.lathe/launch.json` and `.vscode/launch.json` (JSON with
  comments, VS Code's variables, `windows` overrides). "Debug this file" needs none: Python,
  JavaScript and TypeScript start directly, C and C++ are built with debug info (MSVC now also
  writes the linker's PDB), and Rust is built with rustc or `cargo build`.
- **Editor:**
  - a breakpoint gutter: click or F9 to toggle, right-click for conditions, hit counts and
    logpoints; dots show disabled, unverified, conditional and log breakpoints;
  - breakpoints follow their lines as you edit, and are saved with the session;
  - the paused line and the selected frame are highlighted, with an arrow;
  - hovering a name (and the members before it) while paused shows its value, expandable.
- **Run and debug view:** a configuration picker, Start debugging (F5) and Run file, then
  Variables (lazy, editable with a double-click), Watch, Call stack and Breakpoints (with the
  adapter's exception filters and an on/off switch for all of them).
- **Floating toolbar:** continue or pause, step over, into and out, restart and stop. Drag it
  sideways by its grip.
- **Debug console** (a panel): program and adapter output, expandable results, evaluation in the
  paused frame with history and Tab completion.
- **Keys:** F5, F6, F9, F10, F11, Shift+F11, Shift+F5, Ctrl+Shift+F5 and Ctrl+Shift+Y.
- **Fixed:** a `launch.json` program written with `${workspaceFolder}` asked to trust a folder
  literally named that; sessions now belong to the open folder.
- **Tests:**
  - `debug/debug.test.ts` (10): start-up order, failures in the adapter's own words, reverse
    requests, the connection closing, and the breakpoint store.
  - `e2e/debug.spec.ts` (6), with lathe-testkit's fake adapter: a gutter breakpoint and the
    paused line; Variables (expanding and changing a value) and Watch; the Debug console and
    hover; stepping and running to the end; a conditional breakpoint from the gutter menu with a
    launch.json configuration; breakpoints following an edit and coming back after a restart.
  - `e2e/live-debug.spec.ts` (opt-in, `LATHE_LIVE=1`): Python with debugpy, JavaScript with
    js-debug, and C++ built with MSVC under CodeLLDB each stop at a breakpoint, show a variable
    and step over. All three pass (35 s once downloaded).
- Screenshots: `docs/screenshots/m6-{dark,light}.png`.

## M7 (done)

- **`lathe_core::kernels`** (from the Jupyter spike), on `jupyter-zmq-client` 3.0.1:
  - kernelspecs from JUPYTER_PATH, each Python environment's sharejupyter and the user's folders
    (the first name wins);
  - starting a kernel as jupyter_client does on Windows: the interrupt event and the parent
    handle ipykernel waits on, a Job Object, ports held until the kernel binds them;
  - iopub first (waiting for its welcome), shell and stdin with one identity, control;
  - every message passed on as JSON, routed in the UI by its parent's id; the kernel's own
    printing (C code, `os.system`) arrives as log lines;
  - execute with the caller's message id, completions and inspection (code points), `input()`
    replies, interrupt (the event, or interrupt_request), restart on the same ports, shutdown.
  - 2 tests: kernelspec discovery, and running code through the client against the crate's test
    kernel.
- **Tauri:** `kernel_commands.rs` (9 commands). HTML outputs load from a new `lathe-output`
  origin (`output_frame.rs`): a sandboxed iframe without allow-same-origin, with its own CSP;
  the app's `frame-src` allows only that origin.
- **Notebook editor** (`.ipynb` opens in a new `notebook` tab):
  - nbformat 4 read and written as Jupyter writes it (sorted keys, one-space indents, lines
    split, numbers kept as written): an unchanged notebook saves back byte for byte;
  - backed by the file's TextDoc, so saving, dirty state, hot exit and "changed on disk" work as
    for any file;
  - code and Markdown cells; a CodeMirror editor per cell, created as it nears the screen;
  - Jupyter's keys: Shift+Enter, Ctrl+Enter, Alt+Enter; Escape, then A/B, D D, M/Y, Enter, ↑/↓;
    Ctrl+Shift+- splits a cell;
  - run all, interrupt, restart, clear outputs; execution counts and timings;
  - completions and hover documentation from the kernel; `input()` through the quick input.
- **Outputs:** streams and tracebacks with their ANSI colours (the terminal's palette) and
  carriage returns; HTML (inline and sanitized without scripts, else in the output frame); SVG,
  PNG, JPEG and GIF; Markdown; JSON; plain text; `clear_output(wait)` and
  `update_display_data`.
- **Kernels:** Python environments with ipykernel (the folder's `.venv` first, then PATH) and
  kernelspecs. A notebook's kernelspec picks its kernel; otherwise you choose in the toolbar or
  the status bar. A Python without ipykernel offers to install it (after asking, in a terminal).
- **`# %%` cells** in Python files: Run cell and Run below on each marker, Shift+Enter and
  Ctrl+Enter, one kernel per file, output in a new Interactive panel.
- **Fixed:** keys typed right after adding a cell went to the notebook instead of the new cell
  (B then "html()" turned it into Markdown). Your edits now repaint before the next key, and the
  cell's editor is created during that render.
- **Fixed:** the quick input took focus a frame after opening, so a fast Enter could still land in
  the editor (the LSP quick-fix test failed once under load). It now takes focus as it opens.
- **Tests:**
  - `notebook/notebook.test.ts` (9): the byte-for-byte round trip, edits, line splitting,
    Python-style JSON, ANSI spans and carriage returns, joining output.
  - `e2e/notebook.spec.ts` (8), with lathe-testkit's fake kernel (the crate's TestKernel with
    canned answers): Markdown and code cells, running on the named kernel, run all with an image
    and a traceback, restart, the command-mode keys, HTML whose script runs in the sandboxed
    frame, saving as nbformat and reading it back identically, and `# %%` cells in the
    Interactive panel.
  - `e2e/live-notebook.spec.ts` (opt-in, `LATHE_LIVE=1` and `LATHE_LIVE_PYTHON`): a real IPython
    kernel prints, draws a matplotlib chart, answers `input()`, is interrupted in a long loop,
    completes `os.pa` and restarts. All 6 pass.
- Screenshots: `docs/screenshots/m7-{dark,light}.png`.

## M8 (done)

- **`lathe_core::plugins`:** plugins live in `<data>plugins<id>`, described by
  `lathe-plugin.json` (id, version, `engines.lathe`, `main`, activation events,
  contributions, permissions). The manifest is checked (ids, versions, permissions, files that
  must exist and stay inside the folder), and installing goes through staging: a folder is
  copied, a .zip unpacked or an https Git URL shallow-cloned, and only after you've seen the
  install dialog does it move into place. On/off is kept in `state.json`. 3 tests.
- **Tauri:** `plugin_commands.rs` (7 commands) and the `lathe-plugin` origin
  (http://lathe-plugin.localhost): each plugin's host page, the Worker bootstrap, and the plugin's
  own files, with a content security policy that blocks the network unless the plugin asked for
  "network". The app's `frame-src` allows only that origin and `lathe-output`.
- **Runtime** (`plugins/host.ts`): one hidden frame per plugin on that origin, running the
  plugin in a Worker. The plugin gets `lathe` (commands, window, editor, workspace, languages,
  terminal, settings); every call is a message Lathe answers in `plugins/api.ts`, checking the
  plugin's permissions and keeping files inside the open folder.
  - A command that doesn't answer in 10 seconds shows "isn't responding" with Restart.
  - A crashed Worker restarts (up to three times in five minutes).
  - The editor never waits on a plugin; console output goes to the plugin's Output channel.
- **Declared contributions** (no code needed): commands, keybindings (after yours, before
  Lathe's), colour themes in VS Code's format (mapped onto Lathe's tokens and syntax colours; pick
  with "Colour theme…"), snippets in VS Code's format, language servers (trusted folders only)
  and settings. Plugin code can also add completion and hover providers and status bar items.
- **Plugins view** (Ctrl+Shift+X): installed plugins with what they ask for, on/off switches,
  restart and remove; install from a folder, a .zip or a Git URL.
- **Samples** (`plugins/`): Word count (a status bar item and a command) and Sunset (a theme and
  Python snippets, no code). `packages/plugin-api/index.d.ts` has the API's types, and
  `docs/plugins.md` is the guide for writing one.
- **Fixed:** the Worker bootstrap's placeholder was replaced only at its first mention, a comment,
  so plugins couldn't start; the declaration itself is replaced now.
- **Tests:**
  - `plugins/plugins.test.ts` (3): VS Code snippets to CodeMirror's, and theme colours to tokens.
  - `e2e/plugins.spec.ts` (5): Word count installs from its folder after the dialog, its status
    item follows the editor and its command runs from the palette; Sunset's theme changes the
    tokens and its snippet expands; a plugin that throws, reads without permission, hangs (the
    editor keeps typing, then Restart) and crashes (restarted) never stops the editor; turning a
    plugin off removes its command and status item, and removing deletes it.
- Screenshots: `docs/screenshots/m8-{dark,light}.png` (dark with the Sunset theme).

## M9 (done)

- **Settings editor** (Ctrl+,; `workbench/editors/SettingsEditor.tsx`): every setting from
  `services/settingsSchema.ts` (title, description, category, choices, ranges; a new setting
  doesn't compile until it's described there), searchable, by category, for you or for this
  folder. Each kind gets its control: switches, numbers with their range, choices, text, accent
  swatches, colour themes from plugins, glob-pattern and text lists; JSON-only settings link to
  settings.json. Changed settings carry an accent bar and a Reset; plugins' declared settings
  appear under Plugins. "Open settings (JSON)" opens the file as before.
- **Keyboard shortcuts editor** (Ctrl+K Ctrl+S; `KeybindingsEditor.tsx`): every command with its
  keys, `when` clause and where the key comes from (yours, a plugin, Lathe), with clashes marked.
  Change a key by pressing it (two-key chords too), change its `when`, remove it, or reset a
  command; search by text or by pressing keys. Changes go into `keybindings.json`
  (`services/userKeybindings.ts`), entry by entry so comments and order stay (`lib/jsonc.ts`
  list editing). `keybindings.json` in VS Code's format loads at start-up and on save.
- **Vim mode** (`editor.vim`, `@replit/codemirror-vim`), with `:w`, `:q`, `:wq` and `:x`.
- **Markdown preview** (Ctrl+Shift+V, or Ctrl+K V to the side; `MarkdownPreview.tsx`): renders as
  you type; the preview and its editor scroll together (each block knows its source line); links
  to files open them, `#links` go to headings, images beside the file show (network paths are
  refused); double-click a paragraph to go to its source. Previews come back with the session.
- **Import from VS Code** (`services/vscodeImport.ts`): settings Lathe has (values translated:
  pixel line heights, VS Code's choices to on/off, language sections), keybindings mapped to
  Lathe's commands (removals kept), and user snippets copied into `snippets\`. Offered once on a
  first run next to VS Code; always in the palette. Your own snippets load from `snippets\`
  (`services/userSnippets.ts`; "Configure snippets" makes the file for a language).
- **`lathe` command line** (`src-tauri/src/cli.rs`): `bin\lathe.cmd` and `bin\lathe` run
  `lathe.exe --cli`, which hands the arguments to Lathe (`lathe .`, `lathe file:12`) and returns;
  `--wait` returns when those editors close (marker files in %TEMP%, made by the window, or when
  it quits), so `git config core.editor "lathe --wait"` works. A crashed Lathe makes it fail, so
  Git doesn't go on with an unfinished message.
- **Installer** (`pnpm build`): per-user NSIS with hooks (`installer-hooks.nsh`) for "Open with
  Lathe" on files, folders and folder backgrounds, Lathe in "Open with" and Default Apps for code
  files (no default is changed), and `bin` on the user PATH (`bin\lathe-path.ps1`, keeping the
  PATH's form). The uninstaller removes all of it. `pnpm licenses:report` writes
  `docs/licenses.md`. Checked with a silent install and uninstall (`/S`): the installer is
  4.2 MB; every file, verb, type and PATH entry appears, a code file's default is untouched, and
  after uninstalling none of it is left and the user PATH is byte-for-byte what it was.
- **Accessibility:** `e2e/a11y.spec.ts` runs axe (WCAG 2.2 A/AA and best practices) on 13
  screens in dark and light; all pass. Fixes it led to:
  - contrast: the third text grey and light amber are darker or lighter so they read at 4.5:1 on
    hover and selected rows too, labels that used the decoration grey use it no more, and diff
    highlights are lighter;
  - names: status bar items are named by what they show plus what they do ("UTF-8, change
    encoding"); tab close and unpin are mouse targets beside Ctrl+W and the tab menu, with the
    unsaved dot named; the diff editor's sides are named;
  - structure: a page heading, resizers hidden from screen readers, Settings fields with real
    labels, and a valid Source control tree;
  - keyboard: the Source control tree is navigable (arrows, Home/End, Enter opens, Space stages
    or unstages, Delete discards, Left goes up), and its hover buttons are mouse-only;
  - the status bar is 24 px tall, so its buttons meet the target size.
- **Budgets** (debug build, `e2e/budgets.spec.ts`): start 505 ms, idle memory 106 MB, quick open
  over 20,000 files 84 ms, 10 MB file 310 ms, first search result 25 ms, keystroke 2.1 ms median.
- **Tests:**
  - unit: `lib/jsonc.test.ts` (4), `services/vscodeImport.test.ts` (3),
    `workbench/editors/MarkdownPreview.test.ts` (3), keybinding tests (2 more); Rust: `cli` (2).
  - e2e: `preferences.spec.ts` (7: keybindings.json at start-up, the Keyboard shortcuts editor,
    search by keys, the Settings editor, the Markdown preview, a `--wait` launch, the VS Code
    import), `cli.spec.ts` (2: `lathe file:line`, `lathe --wait`), `a11y.spec.ts` (1).
- Screenshots: `docs/screenshots/m9-{dark,light}.png` (a Markdown file and its preview),
  `m9-settings-*.png`, `m9-keys-*.png`.
- **Not done:** more than one window. Lathe is one window per instance (a second launch hands
  its arguments to the first); a second window needs per-window folders, servers, terminals and
  sessions throughout the Rust side.

## Speed pass (done)

Measured with `pnpm build:perf` (release speed, test hooks kept) and `e2e/budgets.spec.ts`:
medians of the old build's warm runs (four) and the new build's (three), on the same PC.

|                                                           |   Before |    After |
| --------------------------------------------------------- | -------: | -------: |
| Start to first paint                                      |   593 ms |   481 ms |
| of which: loading and running the UI's scripts            |   152 ms |    68 ms |
| of which: first render and paint                          |   143 ms |   126 ms |
| of which: WebView2 starting                               |   263 ms |   245 ms |
| JavaScript loaded at start                                | 2,169 KB | 1,290 KB |
| Quick open, typing to that query's results (20,000 files) |    33 ms |     5 ms |
| Opening a 10 MB file                                      |   181 ms |   153 ms |
| Searching 20,000 files, all results                       |   214 ms |   210 ms |
| Keystroke to screen (median, 10 MB file)                  |   2.2 ms |   1.6 ms |
| Memory when idle                                          |   104 MB |   102 MB |

- **Less JavaScript at start (41% less):** the terminal (xterm), Vim mode, Emmet, the diff
  library, the diff, notebook, settings, keyboard shortcuts and Markdown preview editors, and the
  Search, Source control, Run and debug and Plugins views load the first time they're used
  (`ui/lazy.tsx`; dynamic imports in `editor/setup.ts` and `editor/gitGutter.ts`).
- **Tried and dropped: Rust optimised for speed** (`opt-level = 3`). It made `lathe.exe` 3 MB
  bigger and measured within a few percent on every budget (that work waits on the disk, the IPC
  and the UI), so release builds stay size-optimised and the installer stays at 4.2 MB.
- **Quick open asks Rust at once** (it waited 25 ms before each search; stale answers are
  dropped anyway). The old budget test timed mostly its own round trips; it now times inside
  the page.
- **Tabs come back in parallel** (unsaved copies first, then the rest, then previews).
- **Large-file mode** (`editor.largeFileOptimizations`, on): files over 2 MB or 50,000 lines
  open without the minimap, sticky scroll, guides, folding, Git bars, blame or language server,
  with a notice; a big unsaved file is backed up at most every 15 seconds while you type.
- **WebView2's tracking prevention is off** (Lathe's pages are its own and can't reach the
  internet, and Microsoft's docs advise it for that).
- **"Developer: Startup performance"** shows where this window's start-up time went.
- Already in place: WebView2 gives back memory while the window is minimized (since M0).
- **Light accents are darker** (lime, mint, amber): quick open's results now arrive before the
  accessibility test looks, and their highlighted letters were under 4.5:1 on the selected row.
- **Next:** the language-server client (with Markdown) and the debugger's session code still
  load at start; WebView2's own start (about 245 ms) is now the largest part of start-up.
