//! Lathe's engine.
//!
//! Everything here is plain Rust with no Tauri dependency, so it is tested directly
//! (`cargo test -p lathe-core`). The Tauri shell in `apps/lathe/src-tauri` only wires these
//! pieces to the window and the UI.

pub mod dap;
pub mod exec;
pub mod files;
pub mod fsutil;
pub mod git;
pub mod history;
pub mod jsonc;
pub mod kernels;
pub mod lsp;
pub mod paths;
pub mod plugins;
pub mod proc;
pub mod run;
pub mod search;
pub mod session;
pub mod settings;
pub mod shell;
pub mod terminal;
pub mod text;
pub mod toolchains;
pub mod tools;
pub mod workspace;

/// Version of the core, for diagnostics.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Milliseconds since the Unix epoch (UTC), the timestamp format used everywhere in Lathe.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A new time-sortable unique id (UUIDv7).
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
