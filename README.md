# Lathe

A fast, minimal code editor for Windows 11. Edit, run, debug, search and commit in a quiet
"Mono" look: near-black, hairline dividers and one lime accent, with a light twin.

Lathe is built with Tauri 2 (Rust) and React, and its editor is CodeMirror 6. It is not a
VS Code reskin and contains no VS Code code, but it works the way VS Code users expect: the
same keys, `settings.json` and `keybindings.json` in VS Code's format, and a one-click import of
your VS Code settings, keybindings and snippets.

![Lathe in its dark theme](docs/screenshots/m9-dark.png)

## What it does

- **Editing:** multi-cursor, find and replace, folding, minimap, sticky scroll, Emmet, snippets,
  Vim mode, split editors, preview and pinned tabs, unsaved work kept across restarts.
- **Run** any file with ▶ (Ctrl+F5): Python, JavaScript, TypeScript, C and C++ (MSVC, clang or
  g++), Java, Rust, Go, C#, Ruby, PHP, Lua, PowerShell and Bash, in a terminal that takes input.
  Lathe finds your toolchains and offers to install missing ones with winget, asking first.
- **Terminal:** PowerShell, cmd, Git Bash and WSL, with tabs, splits and clickable `file:line`.
- **Search** across files with regex, globs and replace, respecting `.gitignore`.
- **Language smarts** from language servers: completions, errors, go to definition, references,
  rename, code actions, formatting and inlay hints. Lathe downloads the servers it needs (after
  asking), pinned and checked.
- **Debugger:** breakpoints (conditional, hit count, logpoints), stepping, variables, watches
  and a debug console, for Python, JavaScript/TypeScript and C/C++/Rust.
- **Git:** stage hunks from the gutter, commit, branches, push and pull, diffs side by side or
  inline, blame, file history and local history.
- **Notebooks:** `.ipynb` files with a real Jupyter kernel (plots, rich output, interrupt and
  restart), and `# %%` cells in Python files.
- **Plugins:** commands, colour themes (VS Code themes work), snippets, language servers and
  status bar items, each running in its own sandbox. See [docs/plugins.md](docs/plugins.md).
- **Settings and keys:** a searchable Settings editor (Ctrl+,), a Keyboard shortcuts editor that
  records keys and shows clashes (Ctrl+K Ctrl+S), and a Markdown preview that scrolls with its
  file (Ctrl+K V).

## Install

Download `Lathe_<version>_x64-setup.exe` from the newest release on the
[Releases page](https://github.com/INFINITQ/Lathe/releases) and run it. It installs for you
alone (no administrator rights) and adds:

- **Open with Lathe** to the menus of files, folders and folder backgrounds (under "Show more
  options" on Windows 11);
- Lathe to "Open with" and to Settings › Apps › Default apps for code files, without changing
  what any file type opens with;
- `lathe` to your PATH (open a new terminal after installing).

Uninstalling takes all of it out again.

The installer isn't code-signed yet, so Windows SmartScreen may stop it with "Windows protected
your PC". Click **More info**, then **Run anyway**. To check the download first, run
`Get-FileHash Lathe_<version>_x64-setup.exe` in PowerShell: the hash it prints should match the
one in the release's `.sha256` file.

## From a terminal

```powershell
lathe .                 # this folder
lathe src\main.py:12    # a file, at line 12
lathe --wait notes.md   # returns when you close the file
```

To make Lathe Git's editor (commit messages, interactive rebases):

```powershell
git config --global core.editor "lathe --wait"
```

## Coming from VS Code

The first time Lathe starts next to a VS Code installation, it offers to bring your settings,
keybindings and user snippets across (also in the palette: **Preferences: Import from VS
Code**). Settings Lathe has are translated; keybindings to commands Lathe has are kept, with
your `-command` removals.

Your own files live in `%LOCALAPPDATA%\app.lathe`: `settings.json`, `keybindings.json` and
`snippets\` (VS Code's format, `<language>.json` or `*.code-snippets`). A folder's own settings
go in `.lathe/settings.json`; Lathe also reads the common fields of `.vscode/tasks.json` and
`.vscode/launch.json`.

## Develop

You need Windows 11, Node 24+, pnpm 11, Rust 1.99+ (MSVC) and Visual Studio Build Tools with
the C++ workload.

```powershell
pnpm install
pnpm dev              # the app, with the UI reloading as you edit
pnpm verify           # every check: format, lint, types, unit and end-to-end tests
pnpm verify --quick   # the same without the debug build and end-to-end tests
pnpm build            # the installer, in target\release\bundle\nsis
pnpm build:perf       # a release-speed build with the test hooks, for measuring (target\perf)
pnpm licenses:report  # docs/licenses.md
```

GitHub runs `pnpm verify --quick` on every pull request into `main`
([ci.yml](.github/workflows/ci.yml)).

### Releasing

GitHub builds the installer ([release.yml](.github/workflows/release.yml)) when you push a
version tag:

1. Set the new version in both `apps/lathe/src-tauri/tauri.conf.json` (`"version"`) and
   `Cargo.toml` (`version` under `[workspace.package]`). Run `cargo check` so `Cargo.lock` picks
   it up, then merge the change into `main`. (The `package.json` versions aren't used.)
2. Tag that commit and push the tag:

   ```powershell
   git switch main
   git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. The Release workflow checks that the tag matches both versions, builds the installer and
   makes a draft release with `Lathe_0.2.0_x64-setup.exe` and its `.sha256` checksum. Look it
   over on the [Releases page](https://github.com/INFINITQ/Lathe/releases), then click
   **Publish release**.

To build an installer without releasing it, open **Actions › Release › Run workflow** and pick a
branch. The installer is attached to the run as an artifact.

## Layout

```
apps/lathe/            React UI (src/) and the Tauri shell (src-tauri/)
crates/lathe-core/     the engine: files, text, processes, terminals, search, Git, LSP, DAP, kernels
crates/lathe-testkit/  fakes for tests: language server, debug adapter, kernel
packages/plugin-api/   the plugin API (TypeScript)
plugins/               sample plugins
e2e/                   end-to-end tests that drive the real app
docs/                  architecture, decisions (adr/), Windows build notes, status, licenses
```

Read [docs/architecture.md](docs/architecture.md) for how the pieces fit,
[docs/adr/](docs/adr/README.md) for why they are the way they are, and
[docs/STATUS.md](docs/STATUS.md) for what's done.
