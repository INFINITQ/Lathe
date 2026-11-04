// M3: searching and replacing across a folder (keeping each file's format, and searching
// unsaved text), symbols in quick open, back navigation, the outline and sticky scroll.

import { type Page, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

const SHAPES = [
  'import math',
  '',
  '',
  'class Shape:',
  '    """A thing with an area."""',
  '',
  '    def area(self) -> float:',
  '        return 0.0',
  '',
  '',
  'class Circle(Shape):',
  '    def __init__(self, radius: float) -> None:',
  '        self.radius = radius',
  '',
  '    def area(self) -> float:',
  ...Array.from({ length: 60 }, (_, i) => `        step_${i} = ${i}`),
  '        return math.pi * self.radius ** 2',
  '',
  '',
  'def describe(shape: Shape) -> str:',
  '    return f"area {shape.area()}"',
  '',
].join('\n');

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-search-'));
  // CRLF with a BOM, and UTF-16: replacing must keep both exactly.
  writeFileSync(join(dir, 'notes.txt'), '﻿old value\r\nkeep this\r\nold again\r\n');
  const wide = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('an old wide file\r\n', 'utf16le'),
  ]);
  writeFileSync(join(dir, 'wide.txt'), wide);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'config.ts'), 'export const mode = "old";\n');
  writeFileSync(join(dir, 'src', 'shapes.py'), SHAPES);
  // Ignored by .gitignore, so never searched.
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'var old = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  return dir;
}

async function openFile(page: Page, name: string) {
  await page.keyboard.press('Control+P');
  await page.getByRole('combobox').fill(name);
  await expect(page.getByRole('option').first()).toContainText(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

/** The Search view's summary line. */
const status = (page: Page) => page.locator('[data-view="search"] [role="status"]');

test.describe('search', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;

  test.beforeAll(async () => {
    project = makeProject();
    app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project } });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /notes\.txt$/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('finds matches across files, in unsaved text too, and skips ignored files', async () => {
    const { page } = app;
    // An unsaved edit in an open file is searched as it is in the editor.
    await openFile(page, 'config.ts');
    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// old note');
    await page.keyboard.press('Control+Shift+F');
    const box = page.getByRole('textbox', { name: 'Search' });
    await expect(box).toBeFocused();
    await box.fill('old');
    await expect(status(page)).toHaveText('5 results in 3 files');
    const results = page.getByRole('tree', { name: 'Search results' });
    await expect(results).toContainText('notes.txt');
    await expect(results).toContainText('wide.txt');
    await expect(results).toContainText('// old note');
    await expect(results).not.toContainText('bundle.js');

    // Whole word, case and regex toggles.
    await page.getByRole('button', { name: /Use regular expression/ }).click();
    await box.fill('old (value|again)');
    await expect(status(page)).toHaveText('2 results in 1 file');
    await box.fill('old (');
    await expect(status(page)).toContainText(/unclosed|error|regex/i);
    await page.getByRole('button', { name: /Use regular expression/ }).click();
    await box.fill('old');
    await expect(status(page)).toHaveText('5 results in 3 files');

    // Opening a result selects the match.
    await results.getByRole('treeitem').filter({ hasText: 'old again' }).dblclick();
    await expect(page.getByRole('tab', { name: /notes\.txt/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to line (Ctrl+G)' })).toContainText(
      'Ln 3, Col',
    );
  });

  test('replace all keeps CRLF, the BOM and UTF-16, and edits unsaved text in memory', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+H');
    const replace = page.getByRole('textbox', { name: 'Replace' });
    await replace.fill('new');
    await expect(page.getByRole('tree', { name: 'Search results' })).toContainText('new');
    await page.getByRole('button', { name: /Replace all \(Ctrl\+Alt\+Enter\)/ }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(status(page)).toContainText('No results found.');

    expect(readFileSync(join(project, 'notes.txt'))).toEqual(
      Buffer.from('﻿new value\r\nkeep this\r\nnew again\r\n'),
    );
    expect(readFileSync(join(project, 'wide.txt'))).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('an new wide file\r\n', 'utf16le')]),
    );
    // notes.txt was open without changes, so it was saved; config.ts had unsaved changes, so
    // the replacement waits in the editor with them.
    expect(readFileSync(join(project, 'src', 'config.ts'), 'utf8')).toBe(
      'export const mode = "old";\n',
    );
    await page.getByRole('tab', { name: /config\.ts/ }).click();
    await expect(page.locator('.cm-content')).toContainText('mode = "new";// new note');
    await expect(page.getByRole('tab', { name: /config\.ts/ }).getByLabel('Unsaved')).toHaveCount(
      1,
    );
    expect(readFileSync(join(project, 'dist', 'bundle.js'), 'utf8')).toBe('var old = 1;\n');
  });

  test('@ goes to a symbol in the file, and Alt+Left comes back', async () => {
    const { page } = app;
    await openFile(page, 'shapes.py');
    await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Control+Shift+O');
    await expect(page.getByRole('combobox')).toHaveValue('@');
    await expect(page.getByRole('option')).toHaveCount(6);
    await page.getByRole('combobox').fill('@descr');
    await expect(page.getByRole('option').first()).toContainText('describe');
    await page.keyboard.press('Enter');
    const position = page.getByRole('button', { name: 'Go to line (Ctrl+G)' });
    await expect(position).toContainText('Ln 79,');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(position).toContainText('Ln 1,');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(position).toContainText('Ln 79,');
  });

  test('# finds symbols across the folder', async () => {
    const { page } = app;
    await page.keyboard.press('Control+T');
    await page.getByRole('combobox').fill('#circ');
    const option = page.getByRole('option').first();
    await expect(option).toContainText('Circle');
    await expect(option).toContainText('src/shapes.py:11');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Go to line (Ctrl+G)' })).toContainText('Ln 11,');
  });

  test('the outline, breadcrumbs and sticky scroll follow the code', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+E');
    await page.getByRole('button', { name: 'Outline' }).click();
    const outline = page.getByRole('tree', { name: 'Symbols' });
    await expect(outline).toContainText('Shape');
    await expect(outline).toContainText('describe');
    // In Circle.area, the breadcrumbs show where the cursor is.
    await page.keyboard.press('Control+G');
    await page.getByRole('combobox').fill(':40');
    await page.keyboard.press('Enter');
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumbs' });
    await expect(crumbs).toContainText('Circle');
    await expect(crumbs).toContainText('area');
    // Scrolled into Circle.area, its header lines stay pinned at the top.
    await page.locator('.cm-scroller').evaluate((el) => (el.scrollTop = 30 * 18));
    const sticky = page.locator('.cm-sticky-line');
    await expect(sticky.first()).toContainText('class Circle(Shape):');
    await expect(sticky.nth(1)).toContainText('def area(self) -> float:');
  });
});
