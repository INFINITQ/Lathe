// M8: plugins. The Word count sample installs from its folder (after its install dialog); its
// command runs from the palette and its status bar item follows the editor. The Sunset sample's
// theme and snippets work without any code. A plugin that throws, hangs or crashes is noticed,
// can be restarted, and never stops the editor. Turning one off removes what it added.

import { type Page, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type RunningApp, launchApp } from './app';

const WORD_COUNT = resolve('plugins', 'word-count');
const SUNSET = resolve('plugins', 'sunset');

function misbehavingPlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-misbehave-'));
  writeFileSync(
    join(dir, 'lathe-plugin.json'),
    JSON.stringify({
      id: 'test.misbehave',
      name: 'Misbehave',
      version: '1.0.0',
      main: 'main.js',
      contributes: {
        commands: [
          { command: 'misbehave.throw', title: 'Throw an error' },
          { command: 'misbehave.hang', title: 'Hang forever' },
          { command: 'misbehave.crash', title: 'Crash its worker' },
          { command: 'misbehave.read', title: 'Read a file without permission' },
        ],
      },
    }),
  );
  writeFileSync(
    join(dir, 'main.js'),
    [
      'export function activate(lathe) {',
      "  lathe.commands.register('misbehave.throw', () => { throw new Error('boom'); });",
      "  lathe.commands.register('misbehave.hang', () => { for (;;) {} });",
      "  lathe.commands.register('misbehave.crash', () => { setTimeout(() => { throw new Error('crashed on purpose'); }, 0); });",
      "  lathe.commands.register('misbehave.read', () => lathe.workspace.readFile('notes.md'));",
      '}',
    ].join('\n'),
  );
  return dir;
}

async function palette(page: Page, text: string) {
  await page.keyboard.press('Control+Shift+P');
  const quick = page.getByRole('dialog', { name: 'Quick input' });
  await quick.getByRole('combobox').fill(`>${text}`);
  await expect(quick.getByRole('option').first()).toContainText(text);
  await page.keyboard.press('Enter');
}

async function install(page: Page, title: RegExp) {
  await page.keyboard.press('Control+Shift+X');
  await page.getByRole('button', { name: 'Install a plugin' }).click();
  await page.getByRole('menuitem', { name: 'Install from a folder…' }).click();
  const dialog = page.getByRole('alertdialog', { name: title });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Install' }).click();
}

const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: text }).first();

test.describe('plugins', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;
  let misbehave: string;

  test.beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'lathe-plugins-'));
    writeFileSync(join(project, 'notes.md'), 'one two three\n');
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src', 'snip.py'), '\n');
    misbehave = misbehavingPlugin();
    app = await launchApp({
      env: { LATHE_TEST_PICK_FOLDER: [project, WORD_COUNT, SUNSET, misbehave].join(';') },
    });
    const { page } = app;
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await page.getByRole('treeitem', { name: /notes\.md$/ }).dblclick();
    await expect(page.locator('.cm-content')).toContainText('one two three');
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [project, misbehave]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('installs a plugin from a folder after showing what it is', async () => {
    const { page } = app;
    await install(page, /Install Word count 1\.0\.0\?/);
    const item = page.getByRole('list', { name: 'Installed plugins' }).getByRole('listitem', {
      name: 'Word count',
    });
    await expect(item).toBeVisible();
    await expect(item.locator('[data-status]')).toHaveAttribute('data-status', 'running', {
      timeout: 20_000,
    });
  });

  test('its status item follows the editor, and its command runs from the palette', async () => {
    const { page } = app;
    const status = page.locator('[data-plugin-item^="lathe.word-count:"]');
    await page.getByRole('tab', { name: /notes\.md/ }).click();
    await expect(status).toHaveText('3 words', { timeout: 20_000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('four five');
    await expect(status).toHaveText('5 words');
    await palette(page, 'Word count: Count words');
    await expect(toast(page, 'Word count: 5 words in the file.')).toBeVisible();
  });

  test('a plugin without code brings a colour theme and snippets', async () => {
    const { page } = app;
    await install(page, /Install Sunset 1\.0\.0\?/);
    await palette(page, 'Colour theme');
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await quick.getByRole('option', { name: /^Sunset/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--bg')))
      .toBe('#1b1420');
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue('--syn-keyword')),
      )
      .toBe('#ff7eb6');

    await page.keyboard.press('Control+Shift+E');
    await page.getByRole('treeitem', { name: /src$/ }).click();
    await page.getByRole('treeitem', { name: /snip\.py$/ }).dblclick();
    await page.locator('.cm-content').click();
    await page.keyboard.type('ifmain');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('ifmain');
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-content')).toContainText('if __name__ == "__main__":');

    // Back to Mono.
    await palette(page, 'Colour theme');
    await quick.getByRole('option', { name: /^Mono/ }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--bg')))
      .toBe('');
  });

  test("a plugin that throws, hangs or crashes doesn't take the editor down", async () => {
    test.setTimeout(90_000);
    const { page } = app;
    await install(page, /Install Misbehave 1\.0\.0\?/);

    await palette(page, 'Misbehave: Throw an error');
    await expect(toast(page, /"misbehave\.throw" failed/)).toBeVisible({ timeout: 20_000 });
    await expect(toast(page, /"misbehave\.throw" failed/)).toContainText('boom');

    await palette(page, 'Misbehave: Read a file without permission');
    await expect(toast(page, /"misbehave\.read" failed/)).toContainText('workspace.read');

    // A hang runs in the plugin's own worker: the editor keeps working meanwhile.
    await palette(page, 'Misbehave: Hang forever');
    await page.getByRole('tab', { name: /notes\.md/ }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' still typing');
    await expect(page.locator('.cm-content')).toContainText('still typing');
    const stuck = toast(page, "Misbehave isn't responding.");
    await expect(stuck).toBeVisible({ timeout: 20_000 });
    await stuck.getByRole('button', { name: 'Restart it' }).click();
    await palette(page, 'Misbehave: Throw an error');
    await expect(toast(page, /"misbehave\.throw" failed/)).toContainText('boom', {
      timeout: 20_000,
    });

    // An uncaught error kills its worker; Lathe restarts it.
    await palette(page, 'Misbehave: Crash its worker');
    await expect(toast(page, 'Misbehave stopped, and Lathe restarted it.')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('turning a plugin off removes what it added; removing it deletes it', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+X');
    await page.getByRole('switch', { name: 'Word count on' }).uncheck();
    await expect(page.locator('[data-plugin-item^="lathe.word-count:"]')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+P');
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await quick.getByRole('combobox').fill('>Count words');
    await expect(quick.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('switch', { name: 'Word count on' }).check();
    await expect(page.locator('[data-plugin-item^="lathe.word-count:"]')).toBeVisible({
      timeout: 20_000,
    });

    const list = page.getByRole('list', { name: 'Installed plugins' });
    await list.getByRole('listitem', { name: 'Misbehave' }).hover();
    await page.getByRole('button', { name: 'Remove Misbehave' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(list.getByRole('listitem', { name: 'Misbehave' })).toHaveCount(0);
  });
});
