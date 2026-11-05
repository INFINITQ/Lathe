// Launches a Lathe debug build hidden, with WebView2's debugging port open, and connects
// Playwright to its page (Folio's and Hearth's harness, adapted). Debug builds only: release
// builds drop every WEBVIEW2_* variable. Each launch gets a fresh data folder
// (LATHE_TEST_DATA_DIR), so tests never touch the installed app's settings or session.

import { type Browser, type Page, chromium } from '@playwright/test';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The build under test: the debug build, or another one (`pnpm build:perf`'s) by LATHE_E2E_EXE. */
export const EXE = process.env.LATHE_E2E_EXE ?? 'target/debug/lathe.exe';

export type RunningApp = {
  page: Page;
  /** The app's process (WebView2's processes are its children). */
  pid: number;
  /** This launch's data folder (settings.json, session.json, …). */
  dataDir: string;
  /** Stops the app and deletes its data folder; fails if the page threw an uncaught error. */
  close(): Promise<void>;
};

/** Deletes a test data folder; WebView2 lets go of its profile a moment after the app stops. */
function removeDataDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // Still in use: it's in the temp folder, which Windows cleans up.
  }
}

export async function launchApp(
  options: {
    exe?: string;
    port?: number;
    args?: string[];
    env?: Record<string, string>;
    /** Reuse this data folder (a restart) instead of a fresh one. */
    dataDir?: string;
    /** Leave the data folder in place on close (for a restart test). */
    keepData?: boolean;
    /** Start language servers (off in a fresh data folder, so no install offers get in the way). */
    lsp?: boolean;
  } = {},
): Promise<RunningApp> {
  const exe = options.exe ?? EXE;
  const port = options.port ?? 9361;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'lathe-data-'));
  if (!options.dataDir && !options.lsp) {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ 'lsp.enabled': false }));
  }
  const env = {
    ...process.env,
    ...options.env,
    LATHE_BACKGROUND: '1',
    LATHE_TEST_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
  };
  const child: ChildProcess = spawn(exe, options.args ?? [], { env, stdio: 'ignore' });
  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 80 && !browser; attempt++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    child.kill();
    removeDataDir(dataDir);
    throw new Error(`${exe} never opened its debugging port`);
  }
  const page = browser.contexts()[0]!.pages()[0]!;
  // Uncaught errors fail the test (see close): code that works in a plain browser can still
  // break in the app, for example under Tauri's frozen prototypes.
  const errors: string[] = [];
  page.on('pageerror', (error) =>
    errors.push((error.stack ?? String(error)).split('\n').slice(0, 8).join(' | ')),
  );
  const started = () =>
    page.waitForFunction(() => document.querySelector('.lathe-app') !== null, null, {
      timeout: 15_000,
    });
  try {
    await started();
  } catch {
    // It went wrong before we were watching: load it again to see why.
    await page.reload();
    try {
      await started();
    } catch {
      child.kill();
      removeDataDir(dataDir);
      throw new Error(`${exe} didn't start: ${errors.join(' || ') || 'no error was reported'}`);
    }
  }
  return {
    page,
    pid: child.pid ?? 0,
    dataDir,
    close: async () => {
      child.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!options.keepData) removeDataDir(dataDir);
      if (errors.length) throw new Error(`The app threw uncaught errors:\n${errors.join('\n')}`);
    },
  };
}

/**
 * Memory as Task Manager counts it: the private working set of the app and every WebView2
 * process it started, in MB.
 */
export function memoryMb(pid: number): number {
  const script = [
    '$all = Get-CimInstance Win32_Process',
    `$ids = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add(${pid})`,
    'do { $added = $false; foreach ($p in $all) { if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $added = $true } } } while ($added)',
    '$ws = @{}; Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $ws[[uint32]$_.IDProcess] = [uint64]$_.WorkingSetPrivate }',
    '$total = 0; $all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object { $total += $ws[[uint32]$_.ProcessId] }',
    '$total',
  ].join('\n');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
  return Math.round(Number(out.trim()) / 2 ** 20);
}

/** `memoryMb` after a garbage collection and a moment to settle. */
export async function settledMemory(page: Page, pid: number): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  await page.waitForTimeout(1500);
  return memoryMb(pid);
}

/** Records content-policy violations from now on. */
export async function trackViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const target = window as unknown as { __violations: string[] };
    target.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      target.__violations.push(`${e.effectiveDirective} ${e.blockedURI || '(inline)'}`),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
}
