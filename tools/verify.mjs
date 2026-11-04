// Runs every check in order and stops at the first failure.
// Usage: pnpm verify            (everything, including the end-to-end tests)
//        pnpm verify --quick    (skips the debug build and the end-to-end tests)
import { spawnSync } from 'node:child_process';

const quick = process.argv.includes('--quick');

/** @type {[string, string[]][]} */
const steps = [
  ['cargo', ['fmt', '--all', '--check']],
  ['cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']],
  ['cargo', ['test', '--workspace']],
  ['pnpm', ['typecheck']],
  ['pnpm', ['lint']],
  ['pnpm', ['format:check']],
  ['pnpm', ['test']],
  ...(quick
    ? []
    : /** @type {[string, string[]][]} */ ([
        // The embedded (not dev-server) UI matters: frozen prototypes only apply there.
        ['pnpm', ['build:e2e']],
        ['pnpm', ['e2e']],
      ])),
];

for (const [command, args] of steps) {
  const label = `${command} ${args.join(' ')}`;
  console.log(`\n> ${label}`);
  const started = Date.now();
  // A shell is needed on Windows to find pnpm.cmd; every argument here is a fixed string.
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}
console.log('\nAll checks passed.');
