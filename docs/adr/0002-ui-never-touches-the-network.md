# 0002. The UI never opens network connections; Rust does

- Status: accepted
- Date: 2026-11-03

## Context

Lathe downloads language servers and debug adapters, talks to Git remotes, and runs Jupyter
kernels over local sockets. Its webview also renders content Lathe doesn't control: notebook
output, Markdown previews, plugin panels. If the UI could open connections, any of that
content might phone home or exfiltrate code.

## Decision

- The UI's content security policy has `connect-src 'self' ipc: http://ipc.localhost`, so
  only Tauri's own IPC is allowed.
- ESLint bans `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, WebRTC and `sendBeacon`
  in UI code (`eslint.config.js`).
- WebRTC constructors are removed before any page script runs (`src-tauri/src/init.js`), and
  WebView2 runs with `--proxy-server=http://127.0.0.1:9` as a last backstop (Hearth's flags).
- Every download, Git remote, and LSP/DAP/kernel connection lives in Rust, which pins versions
  and checks SHA-256 digests.
- Untrusted content gets its own origin with no Tauri capability:
  - plugins run on `lathe-ext://`;
  - notebook HTML runs on `lathe-output://` in sandboxed iframes.

## Consequences

- Features that would "just fetch" in a browser need a Rust command instead.
- Notebook outputs that load scripts from a CDN (for example Plotly's default) won't load
  them. Rich outputs must carry their scripts inline; Lathe may ship common ones locally later.
