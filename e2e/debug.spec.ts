// M6: the debugger, against lathe-testkit's fake adapter (target\debug\fake-dap.exe), set up as
// your own adapter in settings.json. The fake "runs" a text file a line at a time. Covered:
// a breakpoint from the gutter, the paused line, Variables (expanding and changing a value),
// Watch, the Debug console, hovering a name, stepping, running to the end, a conditional
// breakpoint from the gutter's menu with a launch.json configuration, breakpoints following an
// edit, and breakpoints coming back after a restart.

import { type Page, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type RunningApp, launchApp } from './app';

const FAKE_DAP = resolve('target', 'debug', 'fake-dap.exe');

const PROGRAM = ['start', 'print hello', 'line three', 'print four', 'line five', 'print six', ''];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-debug-'));
  writeFileSync(join(dir, 'prog.txt'), PROGRAM.join('\n'));
  return dir;
}

function makeData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      'lsp.enabled': false,
      'debug.adapters': { fake: { name: 'Fake', command: [FAKE_DAP], languages: ['plaintext'] } },
    }),
  );
  return dir;
}

/** Clicks the breakpoint gutter beside the line that contains `text`. */
async function clickGutter(page: Page, text: string, button: 'left' | 'right' = 'left') {
  const line = await page.locator('.cm-line', { hasText: text }).first().boundingBox();
  const gutter = await page.locator('.cm-breakpointGutter').first().boundingBox();
  if (!line || !gutter) throw new Error(`no line "${text}" or no breakpoint gutter`);
  await page.mouse.click(gutter.x + gutter.width / 2, line.y + line.height / 2, { button });
}

async function focusEditor(page: Page) {
  await page
    .locator('.cm-content')
    .first()
    .click({ position: { x: 200, y: 4 } });
}

test.describe('debugger', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;
  let data: string;

  test.beforeAll(async () => {
    project = makeProject();
    data = makeData();
    app = await launchApp({
      dataDir: data,
      keepData: true,
      env: { LATHE_TEST_PICK_FOLDER: project },
    });
    const { page } = app;
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await page.getByRole('treeitem', { name: /prog\.txt$/ }).dblclick();
    await expect(page.locator('.cm-content')).toContainText('line three');
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    try {
      rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // WebView2 can hold its profile a little longer; the temp folder gets cleaned up anyway.
    }
  });

  test('sets a breakpoint from the gutter, then stops there', async () => {
    const { page } = app;
    await clickGutter(page, 'line three');
    await expect(page.locator('.cm-breakpoint')).toHaveCount(1);
    await page.keyboard.press('Control+Shift+D');
    await expect(page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:3' })).toBeChecked();

    await focusEditor(page);
    await page.keyboard.press('F5');
    await page.getByRole('button', { name: 'Trust and run' }).click();
    await expect(page.locator('.cm-debugStopped')).toHaveText('line three', { timeout: 20_000 });
    await expect(page.getByRole('toolbar', { name: 'Debug toolbar' })).toBeVisible();
    // The adapter verified it, and the program's output reached the Debug console.
    await expect(page.locator('.cm-breakpoint-normal')).toHaveCount(1);
    await expect(page.getByRole('log', { name: 'Debug console' })).toContainText('hello');
    // The fake names its source "program".
    await expect(
      page
        .getByRole('tree', { name: 'Call stack' })
        .getByRole('treeitem', { name: 'main at program:3' }),
    ).toHaveAttribute('aria-selected', 'true');
  });

  test('shows variables, changes one, and watches an expression', async () => {
    const { page } = app;
    const variables = page.getByRole('tree', { name: 'Variables' });
    await expect(variables.getByRole('treeitem', { name: 'line = 3' })).toBeVisible();
    await variables
      .getByRole('treeitem', { name: /^config = / })
      .locator('> div')
      .click();
    await expect(variables.getByRole('treeitem', { name: 'debug = true' })).toBeVisible();

    await variables.getByRole('treeitem', { name: 'line = 3' }).locator('> div').dblclick();
    const input = page.getByRole('textbox', { name: 'New value of line' });
    await input.fill('42');
    await input.press('Enter');
    await expect(variables.getByRole('treeitem', { name: 'line = 42' })).toBeVisible();

    await page.getByRole('region', { name: 'Watch' }).hover();
    await page.getByRole('button', { name: 'Add expression' }).click();
    const expression = page.getByRole('textbox', { name: 'Expression to watch' });
    await expression.fill('line + 1');
    await expression.press('Enter');
    await expect(
      page.getByRole('tree', { name: 'Watch' }).getByRole('treeitem', { name: 'line + 1 = 43' }),
    ).toBeVisible();
  });

  test('evaluates in the Debug console, and on hover', async () => {
    const { page } = app;
    const input = page.getByRole('textbox', { name: 'Debug console input' });
    await input.fill('name');
    await input.press('Enter');
    const log = page.getByRole('log', { name: 'Debug console' });
    await expect(log).toContainText('"fake"');
    await input.fill('nothing');
    await input.press('Enter');
    await expect(log).toContainText("NameError: name 'nothing' is not defined");

    const word = await page.evaluate(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((l) =>
        l.textContent?.includes('line five'),
      );
      const node = line?.firstChild;
      if (!node) return null;
      const range = document.createRange();
      range.setStart(node.nodeType === 3 ? node : node.firstChild!, 1);
      range.setEnd(node.nodeType === 3 ? node : node.firstChild!, 2);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!word) throw new Error('no "line five" line');
    await page.mouse.move(word.x + 30, word.y + 60);
    await page.mouse.move(word.x, word.y);
    await expect(page.locator('.cm-debugHover')).toContainText('line = 42', { timeout: 10_000 });
  });

  test('steps over, then runs to the end', async () => {
    const { page } = app;
    await page.mouse.move(5, 300);
    await focusEditor(page);
    await page.keyboard.press('F10');
    await expect(page.locator('.cm-debugStopped')).toHaveText('print four');
    await expect(page.getByRole('log', { name: 'Debug console' })).toContainText('four');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByRole('log', { name: 'Debug console' })).toContainText('done');
    await expect(page.getByRole('toolbar', { name: 'Debug toolbar' })).toHaveCount(0);
    await expect(page.locator('.cm-debugStopped')).toHaveCount(0);
    // Without a session, the breakpoint is just a breakpoint again.
    await expect(page.locator('.cm-breakpoint-normal')).toHaveCount(1);
  });

  test('a conditional breakpoint stops a launch.json configuration', async () => {
    const { page } = app;
    mkdirSync(join(project, '.lathe'), { recursive: true });
    writeFileSync(
      join(project, '.lathe', 'launch.json'),
      [
        '{',
        '  // The fake adapter, from settings.',
        '  "version": "0.2.0",',
        '  "configurations": [',
        '    { "name": "Fake run", "type": "fake", "request": "launch", "program": "${workspaceFolder}\\\\prog.txt" },',
        '  ],',
        '}',
      ].join('\n'),
    );
    // Turn the first breakpoint off from the list; add one with a condition from the gutter.
    await page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:3' }).uncheck();
    await expect(page.locator('.cm-breakpoint-disabled')).toHaveCount(1);
    await clickGutter(page, 'line five', 'right');
    await page.getByRole('menuitem', { name: 'Add conditional breakpoint…' }).click();
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await quick.getByRole('combobox').fill('line == 5');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-breakpoint-conditional')).toHaveCount(1);

    // The view picks up the configuration; F5 starts it.
    await page.keyboard.press('Control+Shift+D');
    await page.getByRole('button', { name: 'Open launch.json' }).click();
    await expect(page.getByRole('combobox', { name: 'Debug configuration' })).toHaveValue(
      'Fake run',
    );
    await focusEditor(page);
    await page.keyboard.press('F5');
    await expect(page.locator('.cm-debugStopped')).toHaveText('line five', { timeout: 20_000 });
    await expect(page.getByRole('tree', { name: 'Call stack' })).toContainText('Fake run');
    await page.keyboard.press('Shift+F5');
    await expect(page.getByRole('toolbar', { name: 'Debug toolbar' })).toHaveCount(0);
  });

  test('breakpoints follow edits, and come back after a restart', async () => {
    let { page } = app;
    await page.getByRole('tab', { name: /prog\.txt/ }).click();
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('new first line');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+S');
    await expect(page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:4' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:6' })).toBeVisible();
    // Give the session autosave a moment, then start again with the same data folder.
    await page.waitForTimeout(1500);
    await app.close();
    app = await launchApp({
      dataDir: data,
      keepData: true,
      env: { LATHE_TEST_PICK_FOLDER: project },
    });
    page = app.page;
    await page.keyboard.press('Control+Shift+D');
    await expect(
      page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:4' }),
    ).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Breakpoint at prog.txt:6' })).toBeChecked();
    await expect(page.getByRole('tree', { name: 'Watch' })).toContainText('line + 1');
  });
});
