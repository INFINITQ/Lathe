import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp, trackViolations } from './app';

/** A throwaway project folder: a CRLF + BOM text file and a small Python file. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-project-'));
  writeFileSync(join(dir, 'notes.txt'), Buffer.from('﻿first line\r\nsecond line\r\n', 'utf8'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'app.py'),
    'def greet(name: str) -> str:\n    return f"hi {name}"\n',
  );
  return dir;
}

test.describe('workbench', () => {
  let app: RunningApp;
  test.beforeEach(async () => {
    app = await launchApp();
  });
  test.afterEach(async () => {
    await app.close();
  });

  test('starts with the Mono workbench, window controls and bundled fonts', async () => {
    const { page } = app;
    const violations = await trackViolations(page);
    await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
    for (const name of ['Minimize', 'Maximize', 'Close']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Lathe', exact: true })).toBeVisible();
    const inter = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded');
    });
    expect(inter).toBe(true);
    expect(await violations()).toEqual([]);
  });

  test('the command palette lists commands and runs them', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+P');
    const input = page.getByRole('combobox');
    await expect(input).toHaveValue('>');
    await input.pressSequentially('toggle sidebar');
    await expect(page.getByRole('option').first()).toContainText('Toggle sidebar');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(0);
    await page.keyboard.press('Control+B');
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  });
});

test('opens a folder, edits a CRLF + BOM file without changing its format, and splits', async () => {
  const project = makeProject();
  const app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project } });
  try {
    const { page } = app;
    const violations = await trackViolations(page);
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(page.getByRole('treeitem', { name: /notes\.txt$/ })).toBeVisible();

    // Quick open finds the file by a fuzzy name.
    await page.keyboard.press('Control+P');
    await page.getByRole('combobox').fill('nots');
    await expect(page.getByRole('option').first()).toContainText('notes.txt');
    await page.keyboard.press('Enter');
    const content = page.locator('.cm-content');
    await expect(content).toContainText('first line');

    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('third line');
    await expect(page.getByRole('tab', { name: /notes\.txt/ }).getByLabel('Unsaved')).toHaveCount(
      1,
    );
    await page.keyboard.press('Control+S');
    await expect(page.getByRole('tab', { name: /notes\.txt/ }).getByLabel('Unsaved')).toHaveCount(
      0,
    );
    const bytes = readFileSync(join(project, 'notes.txt'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString('utf8')).toBe('first line\r\nsecond line\r\nthird line');

    // Split right: a second group showing the same document, kept in sync.
    await page.keyboard.press('Control+\\');
    await expect(page.locator('[data-group]')).toHaveCount(2);
    await expect(page.locator('.cm-content')).toHaveCount(2);
    await page.locator('.cm-content').nth(1).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    await expect(page.locator('.cm-content').nth(0)).toContainText('third line!');

    // The status bar describes the file.
    const status = page.getByRole('contentinfo', { name: 'Status bar' });
    await expect(status).toContainText('CRLF');
    await expect(status).toContainText('UTF-8 with BOM');
    expect(await violations()).toEqual([]);
  } finally {
    await app.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('brings back the folder, the open editor and unsaved text after a restart', async () => {
  const project = makeProject();
  const dataDir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
  let app = await launchApp({ dataDir, keepData: true, env: { LATHE_TEST_PICK_FOLDER: project } });
  try {
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await app.page.getByRole('treeitem', { name: /src$/ }).click();
    await app.page.getByRole('treeitem', { name: /app\.py$/ }).dblclick();
    const content = app.page.locator('.cm-content');
    await expect(content).toContainText('def greet');
    await content.click();
    await app.page.keyboard.press('Control+End');
    await app.page.keyboard.type('# unsaved');
    // The session (and the unsaved text) are saved a moment after the change.
    await expect
      .poll(
        () =>
          existsSync(join(dataDir, 'session.json')) &&
          readFileSync(join(dataDir, 'session.json'), 'utf8'),
        {
          timeout: 10_000,
        },
      )
      .toContain('app.py');
    await app.page.waitForTimeout(2500);
    await app.close();

    app = await launchApp({ dataDir, keepData: true });
    await expect(app.page.getByRole('tab', { name: /app\.py/ })).toBeVisible();
    await expect(app.page.locator('.cm-content')).toContainText('# unsaved');
    await expect(app.page.getByRole('tab', { name: /app\.py/ }).getByLabel('Unsaved')).toHaveCount(
      1,
    );
    // The file on disk was never touched.
    expect(readFileSync(join(project, 'src', 'app.py'), 'utf8')).not.toContain('# unsaved');
  } finally {
    await app.close();
    rmSync(project, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
