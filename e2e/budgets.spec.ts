// The plan's performance budgets, measured on the hidden debug build (dependencies optimised,
// Lathe's own Rust code not): time until the window's content first paints, memory, quick
// open over a big folder, opening a 10 MB file, and how long a keystroke takes to reach the
// editor's DOM. Memory is what Task Manager counts: the private working set of the app and
// every WebView2 process it started. Numbers are printed; the limits leave room for debug.

import { type Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './app';

function memoryMb(pid: number): number {
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

async function settledMemory(page: Page, pid: number): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.detach();
  await page.waitForTimeout(1500);
  return memoryMb(pid);
}

function makeBigProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-budget-'));
  // 20,000 files in 100 folders, for quick open.
  for (let d = 0; d < 100; d++) {
    const sub = join(dir, 'pkg', `module_${d}`);
    mkdirSync(sub, { recursive: true });
    for (let f = 0; f < 200; f++)
      writeFileSync(join(sub, `component_${f}.ts`), `export const x = ${f};\n`);
  }
  // A 10 MB file.
  const line = 'const value = computeSomething(alpha, beta, gamma); // padding padding\n';
  writeFileSync(join(dir, 'big.ts'), line.repeat(Math.ceil((10 * 2 ** 20) / line.length)));
  return dir;
}

test('stays within its budgets', async () => {
  test.setTimeout(180_000);
  const project = makeBigProject();
  const spawned = Date.now();
  const app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project } });
  const results: Record<string, number> = {};
  try {
    const { page } = app;
    await page.waitForFunction(
      () => performance.getEntriesByName('first-contentful-paint').length > 0,
      null,
      { timeout: 15_000 },
    );
    const painted = await page.evaluate(
      () =>
        performance.timeOrigin +
        performance.getEntriesByName('first-contentful-paint')[0]!.startTime,
    );
    results.startupMs = Math.round(painted - spawned);
    // Where that time went: Rust's steps (from the boot data) and the page's (its marks).
    await page.waitForFunction(() => performance.getEntriesByName('lathe:restored').length > 0);
    const at = await page.evaluate(() => {
      const boot = (window as unknown as { __LATHE_BOOT__?: { startup?: Record<string, number> } })
        .__LATHE_BOOT__?.startup;
      const mark = (name: string) => {
        const entry = performance.getEntriesByName(`lathe:${name}`)[0];
        return entry ? performance.timeOrigin + entry.startTime : 0;
      };
      return {
        process: boot?.process ?? 0,
        boot: boot?.boot ?? 0,
        page: performance.timeOrigin,
        script: mark('script'),
        rendered: mark('rendered'),
      };
    });
    if (at.process) {
      results.rustMs = Math.round(at.boot - at.process);
      results.webviewMs = Math.round(at.page - at.boot);
    }
    results.scriptsMs = Math.round(at.script - at.page);
    results.renderMs = Math.round(at.rendered - at.script);
    results.paintMs = Math.round(painted - at.rendered);
    results.memoryIdleMb = await settledMemory(page, app.pid);

    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: /big\.ts$/ })).toBeVisible();

    // Quick open over 20,000 files, once the index is complete.
    await page.keyboard.press('Control+P');
    const input = page.getByRole('combobox');
    await expect
      .poll(
        async () => {
          await input.fill('');
          await input.fill('mod99cmp199');
          return page.getByRole('option').first().textContent();
        },
        { timeout: 30_000 },
      )
      .toContain('component_199.ts');
    // Timed in the page, from typing the query to its own results showing (waiting from the
    // outside would mostly time the test's round trips, or catch the previous list).
    const timeQuery = (query: string, expected: string) =>
      page.evaluate(
        async ([q, want]) => {
          const input = document.querySelector<HTMLInputElement>('[data-quick-input] input')!;
          const first = () => document.querySelector('[data-quick-input] [role="option"]');
          const type = (text: string) => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(input, text);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const shows = (text: string) =>
            new Promise<void>((done) => {
              if (first()?.textContent?.includes(text)) return done();
              const observer = new MutationObserver(() => {
                if (!first()?.textContent?.includes(text)) return;
                observer.disconnect();
                done();
              });
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
              });
            });
          type('zzqqxx');
          await shows('No matching files');
          const started = performance.now();
          type(q);
          await shows(want);
          return performance.now() - started;
        },
        [query, expected] as const,
      );
    const searches: number[] = [];
    for (const [query, expected] of [
      ['mod7cmp42', 'component_42'],
      ['component_150', 'component_150'],
      ['mod55cmp3', 'component_3'],
      ['compo', 'component_'],
    ] as const) {
      searches.push(await timeQuery(query, expected));
    }
    results.quickOpenMs = Math.round(Math.max(...searches));

    // Open the 10 MB file: once untimed (antivirus scans a new file the first time any program
    // opens it, which took 26 s here and isn't Lathe's time), then again, timed.
    await input.fill('big.ts');
    await expect(page.getByRole('option').first()).toContainText('big.ts');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('computeSomething', {
      timeout: 90_000,
    });
    await page.keyboard.press('Control+W');
    await expect(page.locator('.cm-content')).toHaveCount(0);
    await page.keyboard.press('Control+P');
    await page.getByRole('combobox').fill('big.ts');
    await expect(page.getByRole('option').first()).toContainText('big.ts');
    const opening = Date.now();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('computeSomething');
    results.openBigFileMs = Date.now() - opening;
    // A 10 MB file opens in large-file mode: no minimap (and the other extras) for it.
    // (Soft, so the numbers are still taken and printed if it fails.)
    await expect.soft(page.locator('.cm-minimap')).toHaveCount(0);

    // Search across the 20,000 files and the 10 MB one. The first search also waits for
    // antivirus to scan each new file once (seconds, and not Lathe's time), so the timed one
    // is the second: to its first result and to the end.
    await page.keyboard.press('Control+Shift+F');
    const box = page.getByRole('textbox', { name: 'Search' });
    const summary = page.locator('[data-view="search"] [role="status"]');
    const rows = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem');
    await box.fill('x = 150;');
    const coldStarted = Date.now();
    await box.press('Enter');
    await expect(summary).toHaveAttribute('data-running', 'false', { timeout: 60_000 });
    await expect(summary).toContainText('100 results in 100 files');
    results.searchColdMs = Date.now() - coldStarted;
    await box.fill('x = 151;');
    const warmStarted = Date.now();
    await box.press('Enter');
    await expect(rows.first()).toContainText('component_151');
    results.searchFirstResultMs = Date.now() - warmStarted;
    await expect(summary).toHaveAttribute('data-matches', '100');
    results.searchAllMs = Date.now() - warmStarted;
    await page.getByRole('tab', { name: /big\.ts/ }).click();

    // Keystroke → editor DOM updated, in the 10 MB file.
    await page.locator('.cm-content').click();
    await page.evaluate(() => {
      const target = window as unknown as { __lat: number[]; __t0: number };
      target.__lat = [];
      const content = document.querySelector('.cm-content')!;
      new MutationObserver(() => {
        if (target.__t0) {
          target.__lat.push(performance.now() - target.__t0);
          target.__t0 = 0;
        }
      }).observe(content, { childList: true, subtree: true, characterData: true });
      document.addEventListener('keydown', () => (target.__t0 = performance.now()), true);
    });
    await page.keyboard.type('typing into a big file', { delay: 30 });
    const latencies = await page.evaluate(() =>
      (window as unknown as { __lat: number[] }).__lat.sort((a, b) => a - b),
    );
    results.keystrokeMedianMs =
      Math.round((latencies[Math.floor(latencies.length / 2)] ?? 0) * 10) / 10;
    results.keystrokeP95Ms =
      Math.round((latencies[Math.floor(latencies.length * 0.95)] ?? 0) * 10) / 10;
    results.memoryBigFileMb = await settledMemory(page, app.pid);

    console.log('Budgets (debug build):', JSON.stringify(results));
    test.info().annotations.push({ type: 'budgets', description: JSON.stringify(results) });
    expect(results.startupMs).toBeLessThan(4000);
    expect(results.memoryIdleMb).toBeLessThan(400);
    expect(results.quickOpenMs).toBeLessThan(400);
    expect(results.searchFirstResultMs).toBeLessThan(400);
    expect(results.searchAllMs).toBeLessThan(2000);
    expect(results.openBigFileMs).toBeLessThan(4000);
    expect(results.keystrokeMedianMs).toBeLessThan(16);
  } finally {
    await app.close();
    rmSync(project, { recursive: true, force: true });
  }
});
