// M4: language servers, against lathe-testkit's fake server (target\debug\fake-lsp.exe), set up
// as your own server in settings.json. It covers diagnostics, hover, completion, going to a
// definition in another file, renaming across files, a quick fix, formatting, a request from
// the server, and a crash with an automatic restart.

import { type Page, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type RunningApp, launchApp } from './app';

const FAKE_LSP = resolve('target', 'debug', 'fake-lsp.exe');

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-lsp-'));
  writeFileSync(
    join(dir, 'main.fake'),
    'define greet\ncall greet here\nFIXME later\ntrailing spaces   \n',
  );
  writeFileSync(join(dir, 'other.fake'), 'define helper\ngreet is used here too\n');
  return dir;
}

function makeData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      'lsp.servers': {
        fake: { name: 'Fake LSP', command: [FAKE_LSP], languages: ['plaintext'] },
      },
    }),
  );
  return dir;
}

/** The screen box of `word` in the editor line that contains `lineText`. */
async function wordBox(page: Page, lineText: string, word: string) {
  return page.evaluate(
    ({ lineText, word }) => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) =>
        l.textContent?.includes(lineText),
      );
      if (!line) return null;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(word) ?? -1;
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + word.length);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    },
    { lineText, word },
  );
}

const ready = (page: Page) =>
  expect(page.getByRole('button', { name: 'Language server Fake LSP: ready' })).toBeVisible({
    timeout: 20_000,
  });

test.describe('language servers', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;

  test.beforeAll(async () => {
    project = makeProject();
    app = await launchApp({ dataDir: makeData(), env: { LATHE_TEST_PICK_FOLDER: project } });
    const { page } = app;
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: /main\.fake$/ })).toBeVisible();
    await page.keyboard.press('Control+P');
    await page.getByRole('combobox').fill('main.fake');
    await expect(page.getByRole('option').first()).toContainText('main.fake');
    await page.keyboard.press('Enter');
    // Your own servers run code from the folder, so it has to be trusted first.
    await page.getByRole('button', { name: 'Trust and run' }).click();
    await ready(page);
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('shows diagnostics in the editor and in Problems', async () => {
    const { page } = app;
    await expect(page.locator('.cm-lintRange-warning')).toHaveText('FIXME');
    await expect(page.getByRole('button', { name: /Problems: 0 errors, 1 warning/ })).toBeVisible();
    await page.getByRole('button', { name: /Problems: 0 errors, 1 warning/ }).click();
    await expect(page.getByRole('list', { name: 'Problems' })).toContainText('FIXME: finish this');
  });

  test("answers the server's own requests", async () => {
    const { page } = app;
    await page.getByRole('tab', { name: 'Output' }).click();
    await page.getByRole('combobox', { name: 'Output channel' }).selectOption('Fake LSP');
    await expect(page.getByLabel('Output', { exact: true })).toContainText(
      'fake-lsp: config [null]',
    );
  });

  test('hovers and completes', async () => {
    const { page } = app;
    const box = await wordBox(page, 'call greet here', 'greet');
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x, box!.y);
    await expect(page.locator('.cm-lsp-hover-tooltip, .cm-tooltip-hover').first()).toContainText(
      'fake hover for greet',
      { timeout: 10_000 },
    );
    await page.mouse.move(5, 5);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('fak');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('fakeAlpha');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('fakeAlpha');
  });

  test('F12 goes to a definition in another file', async () => {
    const { page } = app;
    await page.keyboard.press('Enter');
    await page.keyboard.type('use helper');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('F12');
    await expect(page.getByRole('tab', { name: /other\.fake/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Go to line (Ctrl+G)' })).toContainText(
      'Ln 1, Col 8',
    );
  });

  test('F2 renames across files and saves the ones that were saved', async () => {
    const { page } = app;
    await page.getByRole('tab', { name: /main\.fake/ }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.press('F2');
    const input = page.getByRole('combobox', { name: 'New name for greet' });
    await expect(input).toHaveValue('greet');
    await input.fill('welcome');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('define welcome');
    await expect(page.locator('.cm-content')).toContainText('call welcome here');
    // other.fake had no unsaved changes, so the rename was saved there.
    await expect
      .poll(() => readFileSync(join(project, 'other.fake'), 'utf8'))
      .toContain('welcome is used here too');
  });

  test('a quick fix and formatting change the text', async () => {
    const { page } = app;
    const box = await wordBox(page, 'FIXME later', 'FIXME');
    await page.mouse.click(box!.x, box!.y);
    await page.keyboard.press('Control+.');
    await expect(
      page.getByRole('dialog', { name: 'Quick input' }).getByRole('option').first(),
    ).toContainText('Mark as done');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('DONE later');
    await expect(
      page.getByRole('button', { name: /Problems: 0 errors, 0 warnings/ }),
    ).toBeVisible();
    await page.keyboard.press('Shift+Alt+F');
    await expect
      .poll(() => page.locator('.cm-line').filter({ hasText: 'trailing spaces' }).textContent())
      .toBe('trailing spaces');
  });

  test('a server that crashes comes back', async () => {
    const { page } = app;
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('CRASH_NOW');
    await expect(
      page.getByRole('button', { name: /Language server Fake LSP: (restarting|starting)/ }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await page.keyboard.press('Control+Z');
    await expect(page.locator('.cm-content')).not.toContainText('CRASH_NOW');
    await ready(page);
    // Diagnostics come back from the new process.
    await page.keyboard.type(' ERROR');
    await expect(page.getByRole('button', { name: /Problems: 1 error/ })).toBeVisible({
      timeout: 10_000,
    });
  });
});
