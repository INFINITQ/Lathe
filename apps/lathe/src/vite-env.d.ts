/// <reference types="vite/client" />

import type { Boot } from './lib/backend';

declare global {
  interface Window {
    /** Start-up data injected by Rust before any page script runs (see src-tauri/src/window.rs). */
    __LATHE_BOOT__?: Boot;
  }
}
