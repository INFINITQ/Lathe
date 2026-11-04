# 0001. Tauri 2 + React + CodeMirror 6: not Electron, not Monaco

- Status: accepted
- Date: 2026-11-03

## Context

Lathe should have nearly everything VS Code does, but be fast and lightweight, with its own
look rather than being a VS Code reskin. The same owner's other apps (Folio, Hearth) are
Tauri 2 + React + TypeScript monorepos for Windows 11, with tested Windows plumbing: Job
Objects, ConPTY, Snap Layouts, WebView2 hardening, and e2e tests over CDP.

## Decision

- **Shell:** Tauri `=2.12.5`, the same pinned release as Folio and Hearth. WebView2 ships with
  Windows 11, so installers stay small and memory use stays well below Electron's.
- **UI:** React 19 + zustand + Tailwind 4 over CSS-variable tokens, as in Hearth.
- **Editor:** CodeMirror 6, not Monaco.
  - Monaco is VS Code's own editor: heavier, and hard to restyle without looking like VS Code.
  - CodeMirror is modular and lazy-loadable, and every pixel is ours to theme.
  - The features it lacks are filled in by Lathe's own extensions: the LSP session layer,
    minimap, sticky scroll, and the VS Code keymap.
- **Real work lives in Rust (`lathe-core`, no Tauri dependency):** processes, terminals, file
  walking, search, fuzzy matching, Git, and the LSP/DAP/kernel transports.

## Consequences

- Editor features come from CodeMirror extensions or our own code, not VS Code's.
  `@codemirror/lsp-client` covers only part of LSP, so Lathe adds a session layer
  (`docs/build-notes.md`, LSP).
- One owner's three apps share a Tauri release; bump them together.
- WebView2 quirks (frozen prototypes, CSP, accelerator keys) apply; Hearth's fixes are reused.
