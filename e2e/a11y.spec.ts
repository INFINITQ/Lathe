// Accessibility: axe-core checks Lathe's screens against WCAG 2.2 A/AA (and axe's best
// practices), in dark and light. The test walks every screen in each theme, collects everything
// axe finds, and fails once with the whole list.

import { type Page, expect, test } from '@playwright/test';
import type Axe from 'axe-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

const RULES: Axe.RunOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  },
  rules: {
    // WebView2 puts scrolling regions in the Tab order itself, which is what this rule asks for.
    'scrollable-region-focusable': { enabled: false },
  },
};

type Found = { rule: string; impact: string; help: string; nodes: string[] };

/** Runs axe on the page as it is; returns one line per problem. */
async function check(page: Page, where: string, theme: string): Promise<string[]> {
  const found = await page.evaluate(async (options) => {
    const axe = (window as unknown as { axe: typeof Axe }).axe;
    const result = await axe.run(document, options);
    return result.violations.map((v): Found => ({
      rule: v.id,
      impact: v.impact ?? 'unknown',
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => {
        const why = n.failureSummary?.split('\n').slice(1, 2).join(' ').trim() ?? '';
        return `${n.target.join(' ')} :: ${n.html.slice(0, 140)} ${why}`;
      }),
    }));
  }, RULES);
  return found.map(
    (f) => `${where} (${theme}) ${f.rule} [${f.impact}] ${f.help}\n    ${f.nodes.join('\n    ')}`,
  );
}

/** Loads axe into the page (DevTools evaluation isn't bound by the app's content policy). */
async function prepare(page: Page) {
  // No transitions while checking: colours would be read halfway through a change.
  await page.evaluate(() => {
    const sheet = document.styleSheets[0]!;
    sheet.insertRule(
      '*, *::before, *::after { transition: none !important; }',
      sheet.cssRules.length,
    );
  });
  await page.evaluate(AXE_SOURCE);
  expect(await page.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe)).toBe(
    'object',
  );
}

async function palette(page: Page, text: string) {
  await page.keyboard.press('Control+Shift+P');
  const quick = page.getByRole('dialog', { name: 'Quick input' });
  await quick.getByRole('combobox').fill(`>${text}`);
  await expect(quick.getByRole('option').first()).toContainText(text);
  await page.keyboard.press('Enter');
  await expect(quick).toBeHidden();
}

let app: RunningApp;
let project: string;

test.beforeAll(async () => {
  project = mkdtempSync(join(tmpdir(), 'lathe-a11y-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'main.py'), 'def greet(name):\n    return f"Hi {name}"\n');
  writeFileSync(join(project, 'README.md'), '# Notes\n\nSome **notes**, a [link](src/main.py).\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: project,
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'First');
  writeFileSync(join(project, 'src', 'main.py'), 'def greet(name):\n    return f"Hello {name}"\n');
  app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project } });
  await app.page.setViewportSize({ width: 1280, height: 800 });
  await prepare(app.page);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('every screen passes axe in dark and light', async () => {
  test.setTimeout(240_000);
  const { page } = app;
  const problems: string[] = [];

  for (const theme of ['dark', 'light'] as const) {
    await palette(page, `Theme: ${theme}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const see = async (where: string) => {
      const started = Date.now();
      problems.push(...(await check(page, where, theme)));
      console.log(`${theme} ${where}: ${Date.now() - started} ms`);
    };

    if (theme === 'dark') {
      await see('welcome');
      await page.getByRole('button', { name: 'Open folder', exact: true }).click();
      await expect(page.getByRole('treeitem', { name: /src$/ })).toBeVisible();
      await page.getByRole('treeitem', { name: /src$/ }).click();
    }
    await page.keyboard.press('Control+Shift+E');
    // Git's change mark joins the name once its status is in ("main.py M").
    await page.getByRole('treeitem', { name: /^main\.py/ }).dblclick({ timeout: 15_000 });
    await expect(page.locator('.cm-content').first()).toContainText('def greet');
    await see('explorer and editor');

    await page.keyboard.press('Control+P');
    await page.getByRole('dialog', { name: 'Quick input' }).getByRole('combobox').fill('main');
    await expect(
      page.getByRole('dialog', { name: 'Quick input' }).getByRole('option').first(),
    ).toBeVisible();
    await see('quick open');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+Shift+P');
    await expect(
      page.getByRole('dialog', { name: 'Quick input' }).getByRole('option').first(),
    ).toBeVisible();
    await see('command palette');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+Shift+F');
    await page.getByRole('textbox', { name: 'Search' }).fill('greet');
    await expect(
      page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').first(),
    ).toBeVisible();
    await see('search');

    await page.keyboard.press('Control+Shift+G');
    const changes = page.getByRole('group', { name: 'Changes' });
    await expect(changes.getByRole('treeitem').first()).toBeVisible({ timeout: 20_000 });
    await changes.getByRole('treeitem').first().click();
    await expect(page.locator('.cm-mergeView')).toBeVisible();
    await see('source control and diff');

    await page.keyboard.press('Control+Shift+D');
    await expect(page.getByRole('region', { name: 'Toolchains' })).toBeVisible();
    await see('run and debug');

    await page.keyboard.press('Control+Shift+X');
    await expect(page.locator('[data-view="plugins"]')).toBeVisible();
    await see('plugins');

    await page.keyboard.press('Control+Shift+M');
    await expect(page.getByRole('region', { name: 'Panel' })).toBeVisible();
    await see('panel (problems)');
    await page.keyboard.press('Control+`');
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await see('terminal');
    await page.keyboard.press('Control+`');

    await page.keyboard.press('Control+,');
    await expect(page.locator('[data-editor="settings"]')).toBeVisible();
    await see('settings');

    await page.keyboard.press('Control+K');
    await page.keyboard.press('Control+S');
    const keys = page.locator('[data-editor="keybindings"]');
    await expect(keys.locator('tbody tr').first()).toBeVisible();
    await see('keyboard shortcuts');
    await keys.locator('tbody tr').first().dblclick();
    await expect(page.getByRole('dialog', { name: /Keys for/ })).toBeVisible();
    await see('recording keys');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+Shift+E');
    await page.getByRole('treeitem', { name: /^README\.md/ }).dblclick();
    await page.locator('section[data-active="true"] .cm-content').click();
    await page.keyboard.press('Control+K');
    await page.keyboard.press('v');
    await expect(page.locator('[data-editor="preview"] h1')).toBeVisible();
    await see('markdown preview');

    // Back to a calm state for the other theme.
    await palette(page, 'View: Close all editors');
  }

  expect(problems, problems.join('\n')).toEqual([]);
});
