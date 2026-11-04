// M9: the Keyboard shortcuts and Settings editors, the Markdown preview, `lathe --wait` (as the
// Lathe window sees it) and Import from VS Code, in the real app.

import { type Page, expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const toast = (page: Page, text: string | RegExp) =>
  page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: text }).first();

async function palette(page: Page, text: string) {
  await page.keyboard.press('Control+Shift+P');
  const quick = page.getByRole('dialog', { name: 'Quick input' });
  await quick.getByRole('combobox').fill(`>${text}`);
  await expect(quick.getByRole('option').first()).toContainText(text);
  await page.keyboard.press('Enter');
}

const readJson = (path: string) =>
  JSON.parse(
    readFileSync(path, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[\]}])/g, '$1'),
  ) as unknown;

test.describe('preferences', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;
  let vscode: string;

  test.beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'lathe-prefs-'));
    const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of the notes.`);
    writeFileSync(
      join(project, 'README.md'),
      [
        '# Notes',
        '',
        'See [the other file](other.md) or [the end](#the-end).',
        '',
        '![a dot](dot.png)',
        '',
        ...paragraphs.flatMap((p) => [p, '']),
        '## The end',
        '',
      ].join('\n'),
    );
    writeFileSync(join(project, 'other.md'), 'The other file.\n');
    writeFileSync(join(project, 'dot.png'), PNG);
    writeFileSync(join(project, 'snip.py'), '\n');

    vscode = mkdtempSync(join(tmpdir(), 'lathe-vscode-'));
    writeFileSync(
      join(vscode, 'settings.json'),
      '{\n  // VS Code\n  "editor.fontSize": 17,\n  "[python]": { "editor.tabSize": 2 },\n  "python.x": 1,\n}\n',
    );
    writeFileSync(
      join(vscode, 'keybindings.json'),
      '[{ "key": "ctrl+e", "command": "workbench.action.quickOpen" }]',
    );
    mkdirSync(join(vscode, 'snippets'));
    writeFileSync(
      join(vscode, 'snippets', 'python.json'),
      '{ "Main": { "prefix": "ifmain", "body": ["if __name__ == \\"__main__\\":", "    $0"] } }',
    );

    const dataDir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ 'lsp.enabled': false }));
    // Your own keybindings, with a comment that has to survive the editor's changes.
    writeFileSync(
      join(dataDir, 'keybindings.json'),
      '// mine\n[\n  { "key": "ctrl+alt+j", "command": "view.togglePanel" }\n]\n',
    );
    app = await launchApp({
      dataDir,
      env: { LATHE_TEST_PICK_FOLDER: project, LATHE_TEST_VSCODE_DIR: vscode },
    });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /README\.md$/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [project, vscode]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('your keybindings.json is in effect from the start', async () => {
    const { page } = app;
    const panel = page.getByRole('region', { name: 'Panel' });
    const before = await panel.isVisible();
    await page.keyboard.press('Control+Alt+J');
    await expect(panel).toBeVisible({ visible: !before });
    await page.keyboard.press('Control+Alt+J');
    await expect(panel).toBeVisible({ visible: before });
  });

  test('the Keyboard shortcuts editor changes a key, warns of clashes and resets', async () => {
    const { page } = app;
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+S');
    const editor = page.locator('[data-editor="keybindings"]');
    await expect(page.getByRole('tab', { name: /Keyboard shortcuts/ })).toBeVisible();
    await editor
      .getByRole('searchbox', { name: 'Search keyboard shortcuts' })
      .fill('toggle sidebar');
    const row = editor.locator('tr[data-command="view.toggleSidebar"]').first();
    await expect(row).toContainText('Ctrl+B');
    await expect(row).toContainText('Lathe');

    // A clash is pointed out while you record.
    await row.dblclick();
    const dialog = page.getByRole('dialog', { name: /Keys for/ });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Control+P');
    await expect(dialog).toContainText('Also bound to');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // A chord, saved with Enter.
    await row.dblclick();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+9');
    await expect(dialog.locator('[data-recorded]')).toHaveAttribute(
      'data-recorded',
      'ctrl+k ctrl+9',
    );
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    const changed = editor.locator('tr[data-command="view.toggleSidebar"]').first();
    await expect(changed).toContainText('Ctrl+K Ctrl+9');
    await expect(changed).toContainText('Yours');

    const file = join(app.dataDir, 'keybindings.json');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('// mine');
    expect(readJson(file)).toEqual([
      { key: 'ctrl+alt+j', command: 'view.togglePanel' },
      { key: 'ctrl+b', command: '-view.toggleSidebar' },
      { key: 'ctrl+k ctrl+9', command: 'view.toggleSidebar' },
    ]);

    // The new key works and the old one doesn't.
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
    await expect(sidebar).toBeVisible();
    await page.keyboard.press('Control+B');
    await expect(sidebar).toBeVisible();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+9');
    await expect(sidebar).toBeHidden();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+9');
    await expect(sidebar).toBeVisible();

    // Reset brings Lathe's key back.
    await changed.click({ button: 'right' });
    await page.getByRole('menuitem', { name: "Reset to Lathe's" }).click();
    await expect(editor.locator('tr[data-command="view.toggleSidebar"]').first()).toContainText(
      'Ctrl+B',
    );
    expect(readJson(file)).toEqual([{ key: 'ctrl+alt+j', command: 'view.togglePanel' }]);
    expect(readFileSync(file, 'utf8')).toContain('// mine');
  });

  test('shortcuts can be found by pressing them', async () => {
    const { page } = app;
    await palette(page, 'Preferences: Open keyboard shortcuts');
    const editor = page.locator('[data-editor="keybindings"]');
    const search = editor.getByRole('searchbox', { name: 'Search keyboard shortcuts' });
    await search.fill('');
    await editor.getByRole('button', { name: 'Search by pressing keys' }).click();
    await page.keyboard.press('Control+Shift+P');
    await expect(search).toHaveValue('"ctrl+shift+p"');
    await expect(editor.locator('tbody tr')).toHaveCount(1);
    await expect(editor.locator('tbody tr').first()).toHaveAttribute(
      'data-command',
      'quickOpen.commands',
    );
    await editor.getByRole('button', { name: 'Search by pressing keys' }).click();
    await page.keyboard.press('Control+W');
  });

  test('the Settings editor saves each kind of setting, for you or the folder', async () => {
    const { page } = app;
    await page.keyboard.press('Control+,');
    const editor = page.locator('[data-editor="settings"]');
    await expect(page.getByRole('tab', { name: /^Settings/ })).toBeVisible();
    const search = editor.getByRole('searchbox', { name: 'Search settings' });
    const settingsFile = join(app.dataDir, 'settings.json');

    await search.fill('font size');
    const size = editor.locator('[data-setting="editor.fontSize"]');
    await size.getByRole('spinbutton').fill('99');
    await size.getByRole('spinbutton').press('Enter');
    await expect(size).toContainText('Between 8 and 40.');
    await size.getByRole('spinbutton').fill('16');
    await size.getByRole('spinbutton').press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue('--code-size')),
      )
      .toBe('16px');
    expect(readJson(settingsFile)).toMatchObject({ 'editor.fontSize': 16 });
    await size.getByRole('button', { name: 'Reset Font size' }).click();
    await expect
      .poll(() => (readJson(settingsFile) as Record<string, unknown>)['editor.fontSize'])
      .toBeUndefined();

    await search.fill('minimap');
    await editor.locator('[data-setting="editor.minimap.enabled"]').getByRole('checkbox').uncheck();
    await search.fill('word wrap');
    await editor
      .locator('[data-setting="editor.wordWrap"]')
      .getByRole('combobox')
      .selectOption('on');
    await search.fill('accent');
    await editor.getByRole('radio', { name: 'Sky' }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent')))
      .toBe('#bae6fd');
    await search.fill('hidden files');
    const exclude = editor.locator('[data-setting="files.exclude"]');
    await exclude.getByRole('textbox', { name: 'Add a pattern' }).fill('**/dist');
    await exclude.getByRole('textbox', { name: 'Add a pattern' }).press('Enter');
    await expect
      .poll(() => readJson(settingsFile))
      .toMatchObject({
        'editor.minimap.enabled': false,
        'editor.wordWrap': 'on',
        'workbench.accent': 'sky',
        'files.exclude': { '**/.git': true, '**/dist': true },
      });

    // This folder's own settings go in .lathe/settings.json.
    await editor.getByRole('radio', { name: 'This folder' }).click();
    await search.fill('tab size');
    const tabSize = editor.locator('[data-setting="editor.tabSize"]');
    await tabSize.getByRole('spinbutton').fill('2');
    await tabSize.getByRole('spinbutton').press('Enter');
    await expect
      .poll(
        () =>
          existsSync(join(project, '.lathe', 'settings.json')) &&
          readJson(join(project, '.lathe', 'settings.json')),
      )
      .toEqual({ 'editor.tabSize': 2 });
    await editor.getByRole('radio', { name: 'Yours' }).click();
    await expect(tabSize).toContainText('This folder sets it too');
    await page.keyboard.press('Control+W');
  });

  test('the Markdown preview follows the file and its editor', async () => {
    const { page } = app;
    await page.getByRole('treeitem', { name: /README\.md$/ }).dblclick();
    const source = page.locator('.cm-content').first();
    await expect(source).toContainText('# Notes');
    await source.click();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('v');
    const preview = page.locator('[data-editor="preview"]');
    await expect(preview.getByRole('heading', { name: 'Notes', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Preview README\.md/ })).toBeVisible();
    // The image beside the file shows.
    await expect(preview.locator('img[alt="a dot"]')).toHaveAttribute('src', /^blob:/);

    // Typing in the editor updates the preview.
    await source.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.type(' and more');
    await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Notes and more');

    // Scrolling the editor scrolls the preview to the same place.
    const scroller = preview.getByRole('document');
    await page
      .locator('.cm-scroller')
      .first()
      .evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
    const topBlock = () =>
      scroller.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const blocks = [...el.querySelectorAll<HTMLElement>('[data-line]')];
        const first = blocks.find((b) => b.getBoundingClientRect().bottom > top + 4);
        return Number(first?.dataset.line ?? -1);
      });
    const editorTop = await page
      .locator('.cm-scroller')
      .first()
      .evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const lines = [...el.querySelectorAll<HTMLElement>('.cm-line')];
        const first = lines.find((l) => l.getBoundingClientRect().bottom > top + 4);
        return first?.textContent ?? '';
      });
    const paragraph = Number(/Paragraph (\d+)/.exec(editorTop)?.[1] ?? 0);
    expect(paragraph).toBeGreaterThan(20);
    // Paragraph n is on line 6 + 2(n-1) (counting from 0).
    await expect.poll(topBlock).toBeGreaterThan(6 + 2 * (paragraph - 1) - 6);
    expect(await topBlock()).toBeLessThan(6 + 2 * (paragraph - 1) + 6);

    // A #link goes to its heading; a link to a file opens it.
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await preview.getByRole('link', { name: 'the end' }).click();
    await expect(preview.getByRole('heading', { name: 'The end' })).toBeInViewport();
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await preview.getByRole('link', { name: 'the other file' }).click();
    await expect(page.getByRole('tab', { name: /other\.md/ })).toBeVisible();
  });

  test('a --wait launch lets its command go when the file closes', async () => {
    const marker = join(tmpdir(), `lathe-wait-${process.pid}-${Date.now()}`);
    const file = join(project, 'COMMIT_EDITMSG');
    writeFileSync(file, 'Message\n');
    const waiting = await launchApp({
      port: 9372,
      args: [file, `--wait-marker=${marker}`],
    });
    try {
      const { page } = waiting;
      await expect(page.getByRole('tab', { name: /COMMIT_EDITMSG/ })).toBeVisible();
      expect(existsSync(marker)).toBe(false);
      await page.keyboard.press('Control+W');
      await expect.poll(() => existsSync(marker)).toBe(true);
    } finally {
      await waiting.close();
      rmSync(marker, { force: true });
    }
  });

  test('Import from VS Code brings settings, keybindings and snippets', async () => {
    const { page } = app;
    await palette(page, 'Preferences: Import from VS Code');
    await expect(
      toast(page, 'Imported 2 settings, 1 keybinding and 1 snippet file from VS Code.'),
    ).toBeVisible({ timeout: 15_000 });
    expect(readJson(join(app.dataDir, 'settings.json'))).toMatchObject({
      'editor.fontSize': 17,
      '[python]': { 'editor.tabSize': 2 },
    });
    expect(readJson(join(app.dataDir, 'keybindings.json'))).toContainEqual({
      key: 'ctrl+e',
      command: 'quickOpen.files',
    });
    expect(existsSync(join(app.dataDir, 'snippets', 'python.json'))).toBe(true);

    // The imported key works, and so does the snippet.
    await page.keyboard.press('Control+E');
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await expect(quick).toBeVisible();
    await quick.getByRole('combobox').fill('snip.py');
    await expect(quick.getByRole('option').first()).toContainText('snip.py');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: /snip\.py/ })).toBeVisible();
    const editor = page.locator('section[data-active="true"] .cm-content');
    await editor.click();
    await page.keyboard.type('ifmai');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('ifmain');
    await page.keyboard.press('Enter');
    await expect(editor).toContainText('if __name__ == "__main__":');
  });
});
