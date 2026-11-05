// Opening a folder mustn't wait on, or grow with, what's in its build and package folders:
// Rust's target, pnpm's node_modules (full of junctions on Windows), .git. Timed in the page,
// from clicking Open folder to the explorer's first row, with the processor time the app's own
// process used meanwhile and the memory opening the folder added.
//
// LATHE_OPEN_FOLDERS="D:/a;D:/b" times real folders the same way (nothing in them is changed).

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, settledMemory } from './app';

/** Processor time used so far by the app's own process (WebView2's aren't counted), in ms. */
function cpuMs(pid: number): number {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
    ],
    { encoding: 'utf8' },
  );
  return Math.round(Number(out.trim()));
}

/** A folder like a Tauri app's after a build and a pnpm install: little source, much else. */
function makeHeavyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-heavy-'));
  writeFileSync(join(dir, '.gitignore'), 'target/\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const x = 1;\n');
  // 20,000 build outputs.
  for (let d = 0; d < 100; d++) {
    const sub = join(dir, 'target', 'debug', 'deps', `crate_${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 200; f++) writeFileSync(join(sub, `unit_${f}.o`), '');
  }
  // 200 packages of 25 files, linked the way pnpm links them on Windows: a junction at the top
  // for each package, and junctions from each package to five others.
  const real = (p: number) =>
    join(dir, 'node_modules', '.pnpm', `pkg${p}@1.0.0`, 'node_modules', `pkg${p}`);
  for (let p = 0; p < 200; p++) {
    mkdirSync(join(real(p), 'lib'), { recursive: true });
    for (let f = 0; f < 25; f++) writeFileSync(join(real(p), 'lib', `file${f}.js`), '');
  }
  for (let p = 0; p < 200; p++) {
    symlinkSync(real(p), join(dir, 'node_modules', `pkg${p}`), 'junction');
    for (let k = 1; k <= 5; k++) {
      const q = (p + k) % 200;
      const link = join(dir, 'node_modules', '.pnpm', `pkg${p}@1.0.0`, 'node_modules', `pkg${q}`);
      symlinkSync(real(q), link, 'junction');
    }
  }
  return dir;
}

interface Opening {
  /** From clicking Open folder to the explorer's first row. */
  openMs: number;
  /** Processor time the app's own process used meanwhile. */
  cpuMs: number;
  /** The same, a few seconds later (quick open's index and Git status run in the background). */
  cpuSettledMs: number;
  /** Memory that opening the folder added (app and WebView2, after a garbage collection). */
  memoryAddedMb: number;
  memoryMb: number;
}

/** Opens `folder` in a fresh app and measures it. */
async function timeOpening(folder: string): Promise<Opening> {
  const app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: folder } });
  try {
    const { page } = app;
    const button = page.getByRole('button', { name: 'Open folder', exact: true });
    await expect(button).toBeVisible();
    const memoryBefore = await settledMemory(page, app.pid);
    const cpuBefore = cpuMs(app.pid);
    // Timed in the page: waiting from outside would mostly time the test's own round trips.
    const openMs = await button.evaluate(
      (element) =>
        new Promise<number>((done) => {
          const shown = () =>
            document.querySelector('[role="tree"][aria-label="Files"] [role="treeitem"]') !== null;
          const started = performance.now();
          const observer = new MutationObserver(() => {
            if (!shown()) return;
            observer.disconnect();
            done(performance.now() - started);
          });
          observer.observe(document.body, { subtree: true, childList: true });
          (element as HTMLElement).click();
        }),
    );
    const cpuOpen = cpuMs(app.pid) - cpuBefore;
    const memoryAfter = await settledMemory(page, app.pid);
    return {
      openMs: Math.round(openMs),
      cpuMs: cpuOpen,
      cpuSettledMs: cpuMs(app.pid) - cpuBefore,
      memoryAddedMb: memoryAfter - memoryBefore,
      memoryMb: memoryAfter,
    };
  } finally {
    await app.close();
  }
}

test('opens a folder with big build and package folders at once', async () => {
  test.setTimeout(180_000);
  const project = makeHeavyProject();
  try {
    const result = await timeOpening(project);
    console.log('Opening a heavy folder:', JSON.stringify(result));
    test.info().annotations.push({ type: 'open-folder', description: JSON.stringify(result) });
    // It took 1.9 s (all of it processor time) while the watcher walked the whole folder.
    expect(result.openMs).toBeLessThan(500);
    expect(result.cpuMs).toBeLessThan(500);
  } finally {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const realFolders = (process.env.LATHE_OPEN_FOLDERS ?? '').split(';').filter(Boolean);

test('times opening the folders in LATHE_OPEN_FOLDERS', async () => {
  test.skip(realFolders.length === 0, 'Set LATHE_OPEN_FOLDERS to time real folders.');
  test.setTimeout(300_000 * Math.max(1, realFolders.length));
  for (const folder of realFolders) {
    const result = await timeOpening(folder);
    console.log(`Opening ${folder}:`, JSON.stringify(result));
    test.info().annotations.push({ type: folder, description: JSON.stringify(result) });
  }
});
