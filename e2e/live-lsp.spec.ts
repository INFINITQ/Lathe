// Real language servers, installed through Lathe's own install prompts the first time (npm
// for basedpyright, the pinned clangd download), then used: diagnostics, completion, F12 across
// files and a rename. Needs the network once, so it's opt-in:
//   LATHE_LIVE=1 pnpm exec playwright test e2e/live-lsp.spec.ts
// Downloads are kept in %TEMP%\lathe-live-tools between runs.

import { type Page, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './app';

test.skip(!process.env.LATHE_LIVE, 'Set LATHE_LIVE=1 to use real language servers.');

const TOOLS = join(tmpdir(), 'lathe-live-tools');

async function openFile(page: Page, name: string) {
  await page.keyboard.press('Control+P');
  const quick = page.getByRole('dialog', { name: 'Quick input' });
  await quick.getByRole('combobox').fill(name);
  await expect(quick.getByRole('option').first()).toContainText(name);
  await page.keyboard.press('Enter');
}

/** Shows the Problems tab, whether or not the panel is open. */
async function showProblems(page: Page) {
  const tab = page.getByRole('tab', { name: 'Problems' });
  if (await tab.isVisible()) await tab.click();
  else await page.getByRole('button', { name: /Problems:/ }).click();
}

/** Waits for the server to be ready, accepting Lathe's offer to install it first if it comes. */
async function serverReady(page: Page, name: string) {
  const ready = page.getByRole('button', { name: `Language server ${name}: ready` });
  const install = page
    .getByRole('region', { name: 'Notifications' })
    .getByRole('button', { name: 'Install', exact: true });
  await expect(ready.or(install)).toBeVisible({ timeout: 60_000 });
  if (await install.isVisible()) {
    await install.click();
    await expect(page.getByText(`${name} is installed.`)).toBeVisible({ timeout: 300_000 });
  }
  await expect(ready).toBeVisible({ timeout: 120_000 });
}

test('basedpyright and clangd work through Lathe', async () => {
  test.setTimeout(10 * 60_000);
  const project = mkdtempSync(join(tmpdir(), 'lathe-live-'));
  writeFileSync(
    join(project, 'util.py'),
    'def helper(count: int) -> str:\n    return "x" * count\n',
  );
  writeFileSync(
    join(project, 'app.py'),
    'from util import helper\n\nvalue: int = helper(3)\nprint(value)\n',
  );
  writeFileSync(join(project, 'main.cpp'), 'int main() {\n  return undefined_name;\n}\n');
  writeFileSync(join(project, 'main.ts'), 'const count: number = "three";\nexport { count };\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'lathe-data-'));
  if (process.env.LATHE_LIVE_TRACE)
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ 'lsp.trace': 'messages' }));
  const app = await launchApp({
    dataDir,
    env: { LATHE_TEST_PICK_FOLDER: project, LATHE_TEST_TOOLS_DIR: TOOLS },
  });
  try {
    const { page } = app;
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await openFile(page, 'app.py');
    await serverReady(page, 'basedpyright');

    // The type error is reported.
    const problems = page.getByRole('button', { name: /Problems: [1-9]\d* errors?/ });
    await expect(problems).toBeVisible({ timeout: 60_000 });
    await problems.click();
    await expect(page.getByRole('list', { name: 'Problems' })).toContainText('not assignable');

    // Completion knows the imported name.
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('hel');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('helper', {
      timeout: 30_000,
    });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Z');

    // F12 jumps into util.py.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('F12');
    await expect(page.getByRole('tab', { name: /util\.py/ })).toHaveAttribute(
      'aria-selected',
      'true',
      {
        timeout: 30_000,
      },
    );

    // Renaming in util.py changes app.py too, and both were saved, so both are written.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('F2');
    const input = page.getByRole('combobox', { name: 'New name for helper' });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill('assist');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => readFileSync(join(project, 'util.py'), 'utf8'), { timeout: 30_000 })
      .toContain('def assist');
    try {
      await expect
        .poll(() => readFileSync(join(project, 'app.py'), 'utf8'), { timeout: 30_000 })
        .toContain('import assist');
    } catch (err) {
      await page.getByRole('button', { name: /Problems:/ }).click();
      await page.getByRole('tab', { name: 'Output' }).click();
      await page.getByRole('combobox', { name: 'Output channel' }).selectOption('basedpyright');
      const out = (await page.getByLabel('Output', { exact: true }).textContent()) ?? '';
      for (const line of out
        .split('\n')
        .filter((x) => /rename|didClose|didOpen.*app|lathe\]/.test(x))) {
        console.log('TRACE', line.slice(0, 600));
      }
      console.log('TABS', await page.getByRole('tablist', { name: 'Open editors' }).textContent());
      throw err;
    }

    // clangd, from the pinned download.
    await openFile(page, 'main.cpp');
    await serverReady(page, 'clangd');
    await showProblems(page);
    await expect(page.getByRole('list', { name: 'Problems' })).toContainText('undefined_name', {
      timeout: 60_000,
    });

    // TypeScript 7's own language server (tsc --lsp).
    await openFile(page, 'main.ts');
    await serverReady(page, 'TypeScript');
    await showProblems(page);
    await expect(page.getByRole('list', { name: 'Problems' })).toContainText(
      "not assignable to type 'number'",
      {
        timeout: 60_000,
      },
    );
  } finally {
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
