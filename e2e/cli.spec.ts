// M9: `lathe` on the command line, as bin\lathe.cmd runs it (`lathe.exe --cli …`). The command
// starts a Lathe window and returns at once, or with --wait, when the file's editor closes.

import { type Browser, chromium, expect, test } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXE } from './app';

/** Runs `lathe.exe --cli …` with a test data folder; the window it starts listens on `port`. */
function cli(args: string[], port: number, dataDir: string): ChildProcess {
  return spawn(resolve(EXE), ['--cli', ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      LATHE_BACKGROUND: '1',
      LATHE_TEST_DATA_DIR: dataDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((done) => child.once('exit', (code) => done(code)));

async function connect(port: number): Promise<Browser> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('The window Lathe started never opened its debugging port');
}

/** Closes the Lathe window (the command line started it, so the test doesn't own its process). */
async function closeWindow(browser: Browser) {
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) return;
  await page.keyboard.press('Control+Shift+P');
  await page.getByRole('dialog', { name: 'Quick input' }).getByRole('combobox').fill('>File: Exit');
  await expect(
    page.getByRole('dialog', { name: 'Quick input' }).getByRole('option').first(),
  ).toContainText('Exit');
  await page.keyboard.press('Enter');
  await browser.close().catch(() => {});
}

test.describe('command line', () => {
  let folder: string;
  let dataDir: string;

  test.beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'lathe-cli-'));
    dataDir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ 'lsp.enabled': false }));
  });

  test.afterEach(() => {
    for (const dir of [folder, dataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        // WebView2 can hold its profile a little longer; the temp folder gets cleaned anyway.
      }
    }
  });

  test('lathe file:line opens it there and returns at once', async () => {
    writeFileSync(join(folder, 'notes.txt'), 'one\ntwo\nthree\n');
    const command = cli([join(folder, 'notes.txt:3')], 9381, dataDir);
    expect(await exited(command)).toBe(0);
    const browser = await connect(9381);
    try {
      const page = browser.contexts()[0]!.pages()[0]!;
      await expect(page.getByRole('tab', { name: /notes\.txt/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: /go to line/i })).toContainText('Ln 3,');
    } finally {
      await closeWindow(browser);
    }
  });

  test('lathe --wait returns when the file is closed', async () => {
    const message = join(folder, 'COMMIT_EDITMSG');
    writeFileSync(message, '\n# Write the message above.\n');
    const command = cli(['--wait', message], 9382, dataDir);
    let code: number | null | undefined;
    void exited(command).then((c) => (code = c));
    const browser = await connect(9382);
    try {
      const page = browser.contexts()[0]!.pages()[0]!;
      const tab = page.getByRole('tab', { name: /COMMIT_EDITMSG/ });
      await expect(tab).toBeVisible({ timeout: 15_000 });
      // Still waiting while the file is open.
      await page.waitForTimeout(1000);
      expect(code).toBeUndefined();
      await page.locator('.cm-content').click();
      await page.keyboard.type('Fix the thing');
      await page.keyboard.press('Control+S');
      await expect(tab.getByLabel('Unsaved')).toHaveCount(0);
      await page.keyboard.press('Control+W');
      await expect.poll(() => code, { timeout: 10_000 }).toBe(0);
    } finally {
      await closeWindow(browser);
    }
  });
});
