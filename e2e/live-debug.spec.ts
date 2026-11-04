// Opt-in (LATHE_LIVE=1): the real debuggers. The first run downloads them into
// %TEMP%\lathe-live-tools: debugpy for Python, js-debug for JavaScript, CodeLLDB for C++ (built
// with whichever compiler is installed, MSVC here). Each test sets a breakpoint in the gutter,
// clicks "Debug this file", checks a variable, steps over a line and stops.

import { type Locator, type Page, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

test.skip(process.env.LATHE_LIVE !== '1', 'Set LATHE_LIVE=1 to debug with the real adapters.');

const FILES: Record<string, string> = {
  'app.py': [
    'def total(numbers):',
    '    result = 0',
    '    for n in numbers:',
    '        result += n',
    '    return result',
    '',
    '',
    'values = [3, 4, 5]',
    'answer = total(values)',
    'print("answer", answer)',
    '',
  ].join('\n'),
  'app.js': [
    'function total(numbers) {',
    '  let result = 0;',
    '  for (const n of numbers) result += n;',
    '  return result;',
    '}',
    '',
    'const values = [3, 4, 5];',
    'const answer = total(values);',
    "console.log('answer', answer);",
    '',
  ].join('\n'),
  'main.cpp': [
    '#include <iostream>',
    '#include <vector>',
    '',
    'int total(const std::vector<int>& numbers) {',
    '    int result = 0;',
    '    for (int n : numbers) result += n;',
    '    return result;',
    '}',
    '',
    'int main() {',
    '    std::vector<int> values{3, 4, 5};',
    '    int answer = total(values);',
    '    std::cout << "answer " << answer << "\\n";',
    '}',
    '',
  ].join('\n'),
};

async function clickGutter(page: Page, text: string) {
  const line = await page.locator('.cm-line', { hasText: text }).first().boundingBox();
  const gutter = await page.locator('.cm-breakpointGutter').first().boundingBox();
  if (!line || !gutter) throw new Error(`no line "${text}" or no breakpoint gutter`);
  await page.mouse.click(gutter.x + gutter.width / 2, line.y + line.height / 2);
}

/** Answers the trust and download questions until `done` shows up. */
async function answerUntil(page: Page, done: Locator, timeout: number) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await done.count()) return;
    for (const name of ['Trust and run', 'Download']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    await page.waitForTimeout(250);
  }
  throw new Error('timed out waiting for the debugger to stop');
}

test.describe('live debuggers', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;

  test.beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'lathe-live-debug-'));
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(project, name), text);
    app = await launchApp({
      env: {
        LATHE_TEST_PICK_FOLDER: project,
        LATHE_TEST_TOOLS_DIR: join(tmpdir(), 'lathe-live-tools'),
      },
    });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /app\.py$/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function debugFile(options: {
    file: string;
    breakAt: string;
    variable: RegExp;
    next: string;
    after: RegExp;
  }) {
    const { page } = app;
    await page.keyboard.press('Control+Shift+E');
    await page
      .getByRole('treeitem', { name: new RegExp(`${options.file.replace('.', '\\.')}$`) })
      .dblclick();
    await expect(page.locator('.cm-content')).toContainText(options.breakAt);
    await clickGutter(page, options.breakAt);
    await expect(page.locator('.cm-breakpoint')).toHaveCount(1);
    await page.getByRole('button', { name: 'Debug this file' }).click();
    const stopped = page.locator('.cm-debugStopped');
    await answerUntil(page, stopped, 300_000);
    await expect(stopped).toHaveText(options.breakAt);

    await page.keyboard.press('Control+Shift+D');
    const variables = page.getByRole('tree', { name: 'Variables' });
    await expect(variables.getByRole('treeitem', { name: options.variable }).first()).toBeVisible({
      timeout: 20_000,
    });

    await page
      .locator('.cm-content')
      .first()
      .click({ position: { x: 200, y: 4 } });
    await page.keyboard.press('F10');
    await expect(stopped).toHaveText(options.next, { timeout: 20_000 });
    await expect(variables.getByRole('treeitem', { name: options.after }).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.keyboard.press('Shift+F5');
    await expect(page.getByRole('toolbar', { name: 'Debug toolbar' })).toHaveCount(0, {
      timeout: 20_000,
    });
    // Clean up for the next language.
    await page.getByRole('button', { name: 'Remove all breakpoints' }).click();
  }

  test('Python with debugpy', async () => {
    test.setTimeout(420_000);
    await debugFile({
      file: 'app.py',
      breakAt: 'answer = total(values)',
      variable: /^values = \[3, 4, 5\]/,
      next: 'print("answer", answer)',
      after: /^answer = 12/,
    });
  });

  test('JavaScript with js-debug', async () => {
    test.setTimeout(420_000);
    await debugFile({
      file: 'app.js',
      breakAt: 'const answer = total(values);',
      variable: /^values = /,
      next: "console.log('answer', answer);",
      after: /^answer = 12/,
    });
  });

  test('C++ with CodeLLDB', async () => {
    test.setTimeout(600_000);
    await debugFile({
      file: 'main.cpp',
      breakAt: 'int answer = total(values);',
      variable: /^values = /,
      next: 'std::cout << "answer " << answer << "\\n";',
      after: /^answer = 12/,
    });
  });
});
