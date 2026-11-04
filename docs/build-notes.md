# Build notes

Windows traps and verified facts. Most of the first part comes from Hearth's build notes,
because the same code runs here.

## Child processes (`lathe_core::proc`; clippy bans raw `Command::new`)

- **Every spawn:**
  - gets `CREATE_NO_WINDOW`; otherwise a GUI app flashes a console window per child;
  - starts `CREATE_SUSPENDED`, then joins its Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`),
    then its threads resume;
  - `TerminateJobObject` kills the whole tree.
- **Always drain stdout and stderr.** A full 4–64 KB pipe blocks the child.
- **`.cmd` shims** (npx, pnpm, many language servers): resolve them with `which`, which honours
  PATHEXT. Rust ≥ 1.77 escapes `.cmd` arguments safely, or returns an error.
- **Never build `-c "<cmd>"` strings.** MSVC and Cygwin quoting differ.
  - Bash: a temp `.sh` script run with `bash -l <script>` and `CHERE_INVOKING=1`.
  - PowerShell: `-EncodedCommand`, or a temp `.ps1` for long commands.
- **Git Bash:** found via `HKLM\SOFTWARE\GitForWindows\InstallPath`, or `git.exe` → `..\bin\bash.exe`.
  Never `C:\Windows\System32\bash.exe`: that's WSL.
- **Python:** the Microsoft Store `python3` stub exits with 9009. Ignore anything under
  `WindowsApps`.
- **Ports:** bind `127.0.0.1:0` to get a free port, and retry if binding fails, because Hyper-V
  reserves port ranges.

## Paths, encodings, writes

- **Paths:** `C:\…`, `C:/…`, `/c/…`, `/mnt/c/…` and `~` are all accepted and normalised with
  `dunce`.
- **Reserved names:** `CON PRN AUX NUL COMn LPTn`, trailing dots or spaces, and `:` streams are
  rejected.
- **Encodings:** detect a BOM, then UTF-16, then UTF-8, and otherwise guess with `chardetng`.
  CodeMirror stores `\n` internally, so saving converts back to the file's own line endings and
  keeps its BOM and encoding (`lathe_core::text`).
- **Writes:** a temp file, then `MoveFileExW(REPLACE_EXISTING)`. Retry 3× at 100 ms, because
  antivirus and the indexer cause sharing violations.
- **First opens are slow:** Defender scans a new file the first time any program opens it. A
  fresh 10 MB file took 26 s to open (M1) and held up a search that included it by the same
  26 s (M3); 20,000 new small files added about 2 s to the first search. Afterwards the same
  search takes 160 ms. Benchmarks must warm files up first. Search streams results, so the rest
  still shows at once, and it retries sharing violations and reports unreadable files rather
  than dropping them silently.
- **Long paths:** enable `longPathAware` in the manifest.
- **File URIs for LSP:** use a lower-case drive letter and `%3A`, and compare paths
  case-insensitively.

## WebView2

- **Lathe creates its own WebView2 environment** (`webview2.rs`, from Folio's ADR 0002).
  - Crash dumps stay local.
  - Browser accelerator keys are off, so F5, Ctrl+P and Ctrl+F reach the editor.
  - The browser context menu and zoom are off.
  - Every permission prompt is denied.
- **`freezePrototype`** breaks libraries that assign onto prototypes. xterm needs the Vite patch
  in `vite.config.ts`.
- **The hidden window runs no CSS transitions,** so tests that read colours switch transitions
  off first.
- **Channels:** JSON under 8 KB and raw payloads under 1 KB go through `webview.eval`, and larger
  ones through a fetch round trip, so batch messages.

## Speed

- **Measure at release speed:** `pnpm build:perf` builds into `target\perf` with debug assertions
  on, which keeps the test hooks; `$env:LATHE_E2E_EXE = 'target/perf/release/lathe.exe'` points
  the end-to-end tests (the budgets above all) at it. The debug build's numbers aren't release
  numbers.
- **`opt-level = 3` didn't pay:** 3 MB more, and within a few percent on every budget. Whole-program LTO
  also ignores per-crate `opt-level`: the final code follows the binary's level,
  so the release profile's own `opt-level` is what counts.
- **Start-up JavaScript:** anything not on the first screen loads on first use (`ui/lazy.tsx`
  for views; dynamic `import()` for editor extensions such as Vim and Emmet). Check
  `dist/index.html`'s preloads after adding a dependency: a static import from a start-up module
  pulls a whole library back in.
- **Timing a UI step from a test:** wait inside the page (a `MutationObserver` on the result)
  rather than with locators from outside, which mostly time the test's own round trips and can
  catch the previous screen.
- **"Developer: Startup performance"** shows each start-up step of the current window (Rust's
  from the boot data, the page's from `performance` marks).

## Research findings to apply (2026-11-03)

- **LSP:** `@codemirror/lsp-client` 6.3.0's transport passes bare JSON strings, so Rust strips
  the `Content-Length` framing.
  - **Implemented:** completion (no resolve), hover, signature help, push diagnostics,
    definition, declaration, type definition, implementation, references, rename, and
    whole-document formatting.
  - **Missing:** code actions, inlay hints, semantic tokens, document and workspace symbols,
    document highlight, range formatting, `didSave`, `didChangeWatchedFiles`, progress, and
    workspace folders.
  - **Server-to-client requests** are answered with MethodNotFound.
  - **Lathe's session layer** therefore rewrites `initialize` and answers
    `workspace/configuration`, `registerCapability` and `applyEdit` itself. It adds the
    missing features as extensions.
- **TypeScript:**
  - TypeScript 7 (`typescript@7`, native) ships only `tsc`, and its language server is
    `tsc --lsp --stdio`.
  - `typescript-language-server` 6.0.3 needs TypeScript ≤ 6's tsserver.
- **Jupyter:**
  - **Crates:** `jupyter-zmq-client` 3.0.1 + `jupyter-protocol` 2.0.3 + `zeromq` 0.7.0, with
    `default-features = false` and `["tokio-runtime", "ring"]`. `runtimelib` is deprecated.
  - **Windows interrupt:** pass an inheritable event in `JPY_INTERRUPT_EVENT` and the parent's
    handle in `JPY_PARENT_PID`.
- **Debugging:**
  - **Python:** debugpy 1.8.22, TCP.
  - **JS:** vscode-js-debug 1.140.0, run as `node dapDebugServer.js <port>` over TCP; it opens
    child sessions with `startDebugging`.
  - **C++:** CodeLLDB 1.12.3 over stdio (MIT; bundles LLDB 22). Its PDB support is weaker than
    DWARF, so prefer clang `-gdwarf` when LLVM is installed.
  - Don't use vsdbg/cppvsdbg: their licence limits them to Microsoft products.
- **Language servers:** basedpyright 1.40.2, clangd 23.1.0, jdtls 1.63.0, and rust-analyzer
  (weekly releases).
- **MSVC environment:** run `VsDevCmd.bat -arch=amd64 -no_logo && set` once, diff the result
  against the normal environment, and cache it per VS instance.
- **winget:**
  - Run `winget install --id <ID> -e --source winget --accept-package-agreements
--disable-interactivity`, after showing you the command.
  - Afterwards, re-read PATH from the registry.
- **Unmaintained packages:**
  - `cmdk` and `@replit/codemirror-minimap`: Lathe has its own palette and minimap.
  - `nucleo` (last release 2024): kept behind an interface so it can be swapped for `frizbee`.
