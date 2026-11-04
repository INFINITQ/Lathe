//! Test doubles for Lathe's integration and end-to-end tests: a fake language server, a fake
//! debug adapter and a fake Jupyter kernel, added as the matching features land.

use std::path::{Path, PathBuf};

/// The folder with shared test fixtures (`crates/lathe-testkit/fixtures`).
pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}
