// A build that runs at release speed but keeps the test hooks (debug assertions switch them
// on), so the end-to-end performance budget can measure what you'd really get:
//
//   pnpm build:perf
//   $env:LATHE_E2E_EXE = 'target/perf/release/lathe.exe'; pnpm e2e budgets
//
// It builds into target/perf, so it never mixes with the real release build (which has no test
// hooks and is what the installer ships).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const env = {
  ...process.env,
  CARGO_TARGET_DIR: resolve('target/perf'),
  CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS: 'true',
};
// One command string: pnpm is a .cmd file, which Windows only runs through a shell.
const result = spawnSync('pnpm --filter @lathe/app tauri build --no-bundle', {
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
