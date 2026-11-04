// M5: source control on a real temporary repository: the gutter bar of a change, staging one
// hunk from it, committing, creating a branch, the diff editor, Explorer decorations, merge
// conflict buttons and local history.

import { type Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Lathe Test');
  git(dir, 'config', 'user.email', 'test@lathe.invalid');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'app.py'), "print('one')\nprint('two')\n");
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nFirst.\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Start');
  return dir;
}

async function openFile(page: Page, name: string) {
  await page.keyboard.press('Control+P');
  const quick = page.getByRole('dialog', { name: 'Quick input' });
  await quick.getByRole('combobox').fill(name);
  await expect(quick.getByRole('option').first()).toContainText(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

test.describe('source control', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let repo: string;

  test.beforeAll(async () => {
    repo = makeRepo();
    app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: repo } });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /app\.py/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('shows the branch, and a change in the gutter', async () => {
    const { page } = app;
    await expect(page.getByRole('button', { name: 'Branch main' })).toBeVisible();
    await openFile(page, 'app.py');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.type('  # changed');
    await page.keyboard.press('Control+S');
    await expect(page.locator('.cm-gitBar.cm-git-modified')).toHaveCount(1);
    // The Explorer marks the file as modified.
    await expect(page.getByRole('treeitem', { name: /app\.py/ })).toContainText('M');
  });

  test('stages one hunk from the gutter, then commits it', async () => {
    const { page } = app;
    await page.locator('.cm-gitBar.cm-git-modified').click();
    const peek = page.locator('.cm-gitPeek');
    await expect(peek).toContainText("print('one')");
    await peek.getByRole('button', { name: 'Stage' }).click();
    await expect(page.locator('.cm-gitBar')).toHaveCount(0);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('app.py');

    await page.keyboard.press('Control+Shift+G');
    const staged = page.getByRole('group', { name: 'Staged changes' });
    await expect(staged.getByRole('treeitem', { name: 'app.py M' })).toBeVisible();
    const message = page.getByRole('textbox', { name: 'Commit message' });
    await message.fill('Change one');
    await message.press('Control+Enter');
    await expect(page.locator('[data-view="scm"]')).toContainText('No changes.');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Change one');
  });

  test('creates a branch from the status bar', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Branch main' }).click();
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await quick.getByRole('option', { name: /Create a new branch…/ }).click();
    await quick.getByRole('combobox').fill('feature');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Branch feature' })).toBeVisible();
    expect(git(repo, 'branch', '--show-current')).toBe('feature');
  });

  test('a change made outside opens in the diff editor', async () => {
    const { page } = app;
    writeFileSync(join(repo, 'notes.md'), '# Notes\n\nFirst.\nSecond.\n');
    const changes = page.getByRole('group', { name: 'Changes' });
    const row = changes.getByRole('treeitem', { name: 'notes.md M' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(
      page.getByRole('tab', { name: /notes\.md \(staged ↔ working tree\)/ }),
    ).toBeVisible();
    await expect(page.locator('.cm-mergeView')).toBeVisible();
    await expect(page.locator('.cm-merge-b .cm-changedLine')).toContainText('Second.');
  });

  test('merge conflicts get accept buttons', async () => {
    const { page } = app;
    writeFileSync(
      join(repo, 'conflict.txt'),
      'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nbottom\n',
    );
    // A file that just appeared: open it from the Explorer once it shows up there.
    await page.keyboard.press('Control+Shift+E');
    const item = page.getByRole('treeitem', { name: /conflict.txt/ });
    await expect(item).toBeVisible({ timeout: 10_000 });
    await item.dblclick();
    await expect(page.locator('.cm-conflict-current')).toHaveText('mine');
    await page
      .locator('.cm-conflictActions')
      .getByRole('button', { name: 'Accept incoming' })
      .click();
    await expect(page.locator('.cm-content')).toHaveText('toptheirsbottom');
  });

  test('local history compares with an earlier save', async () => {
    const { page } = app;
    await openFile(page, 'app.py');
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('print("three")');
    await page.keyboard.press('Control+S');
    // The save (and its copy in local history) is done once the tab is clean.
    await expect(page.getByRole('tab', { name: /app\.py/ }).getByLabel('Unsaved')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+P');
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await quick.getByRole('combobox').fill('>earlier save');
    await page.keyboard.press('Enter');
    // The newest copy is this save; the one before is the first save.
    await expect(quick.getByRole('option')).toHaveCount(2);
    await quick.getByRole('option').nth(1).click();
    await expect(page.locator('.cm-mergeView')).toBeVisible();
    await expect(page.locator('.cm-merge-b .cm-changedLine')).toContainText('print("three")');
    expect(readFileSync(join(repo, 'app.py'), 'utf8')).toContain('print("three")');
  });

  test('the Changes tree works from the keyboard', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+G');
    const tree = page.getByRole('tree', { name: 'Changes' });
    // Tab lands on the first heading; the arrows move to the file below it.
    await tree.getByRole('treeitem').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: 'app.py M' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(
      page
        .getByRole('group', { name: 'Staged changes' })
        .getByRole('treeitem', { name: 'app.py M' }),
    ).toBeVisible();
    await tree.getByRole('treeitem', { name: 'app.py M' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.cm-mergeView')).toBeVisible();
  });
});
