// M7: notebooks, against lathe-testkit's fake kernel (target\debug\fake-kernel.exe), found as a
// kernelspec on JUPYTER_PATH. Covered: rendering cells, running one, run all with an image and
// an error, restarting the kernel, Jupyter's command-mode keys, saving in nbformat (and reading
// it back the same), and # %% cells in a Python file running into the Interactive panel.

import { type Page, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type RunningApp, launchApp } from './app';

const FAKE_KERNEL = resolve('target', 'debug', 'fake-kernel.exe');

const cell = (type: 'code' | 'markdown', id: string, source: string[]) => ({
  cell_type: type,
  id,
  metadata: {},
  source,
  ...(type === 'code' ? { execution_count: null, outputs: [] } : {}),
});

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-nb-'));
  writeFileSync(
    join(dir, 'demo.ipynb'),
    JSON.stringify(
      {
        cells: [
          cell('code', 'aaaa0001', ['print(1+1)']),
          cell('markdown', 'aaaa0002', ['# Fake notebook\n', '\n', 'Some **bold** text.']),
          cell('code', 'aaaa0003', ['plot()']),
          cell('code', 'aaaa0004', ['fail()']),
        ],
        metadata: {
          kernelspec: { display_name: 'Fake kernel', language: 'python', name: 'fake' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    ),
  );
  writeFileSync(join(dir, 'cells.py'), '# %%\nprint(1+1)\n\n# %%\n1 + 1\n');
  return dir;
}

function makeKernelspec(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-jupyter-'));
  mkdirSync(join(dir, 'kernels', 'fake'), { recursive: true });
  writeFileSync(
    join(dir, 'kernels', 'fake', 'kernel.json'),
    JSON.stringify({
      argv: [FAKE_KERNEL, '-f', '{connection_file}'],
      display_name: 'Fake kernel',
      language: 'python',
    }),
  );
  return dir;
}

const cellAt = (page: Page, n: number) =>
  page.getByRole('list', { name: 'Cells' }).getByRole('listitem').nth(n);

async function openNotebook(page: Page) {
  await page.keyboard.press('Control+Shift+E');
  await page.getByRole('treeitem', { name: /demo\.ipynb$/ }).dblclick();
  await expect(page.getByRole('list', { name: 'Cells' })).toBeVisible();
}

test.describe('notebooks', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;
  let jupyter: string;

  test.beforeAll(async () => {
    project = makeProject();
    jupyter = makeKernelspec();
    app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project, JUPYTER_PATH: jupyter } });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /demo\.ipynb$/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [project, jupyter]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('shows code and rendered Markdown cells', async () => {
    const { page } = app;
    await openNotebook(page);
    await expect(page.getByRole('list', { name: 'Cells' }).getByRole('listitem')).toHaveCount(4);
    await expect(cellAt(page, 1).getByRole('heading', { name: 'Fake notebook' })).toBeVisible();
    await expect(cellAt(page, 1).locator('strong')).toHaveText('bold');
    await expect(cellAt(page, 0).locator('.cm-content')).toHaveText('print(1+1)');
  });

  test('runs a cell on the kernel the notebook names', async () => {
    const { page } = app;
    await cellAt(page, 0).getByRole('button', { name: 'Run cell 1' }).click();
    const output = cellAt(page, 0).getByRole('group', { name: 'Output' });
    await expect(output).toHaveText('2', { timeout: 30_000 });
    await expect(cellAt(page, 0).getByLabel('Execution count 1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Kernel Fake kernel: idle' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notebook kernel: Fake kernel' })).toBeVisible();
  });

  test('runs all: an image, and an error with its traceback', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Run all' }).click();
    await expect(cellAt(page, 2).locator('[data-mime="image/png"] img')).toBeVisible();
    await expect(cellAt(page, 3).locator('[data-error="ValueError"]')).toContainText(
      'ValueError: it failed on purpose',
    );
    // The fake kernel numbers runs: cell 1 again (2), plot (3), fail (4).
    await expect(cellAt(page, 3).getByLabel('Execution count 4')).toBeVisible();
  });

  test('restarts the kernel, which counts from 1 again', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Restart the kernel' }).click();
    await expect(page.getByRole('button', { name: 'Kernel Fake kernel: idle' })).toBeVisible({
      timeout: 30_000,
    });
    await cellAt(page, 0).getByRole('button', { name: 'Run cell 1' }).click();
    await expect(cellAt(page, 0).getByLabel('Execution count 1')).toBeVisible({ timeout: 30_000 });
  });

  test('command mode keys add, run and delete cells, as in Jupyter', async () => {
    const { page } = app;
    // Select the last cell (command mode), add one below with B, and run it.
    await cellAt(page, 3).locator('.nb-gutter').click();
    await page.keyboard.press('b');
    await expect(page.getByRole('list', { name: 'Cells' }).getByRole('listitem')).toHaveCount(5);
    await page.keyboard.type('1 + 1');
    await page.keyboard.press('Shift+Enter');
    await expect(cellAt(page, 4).getByRole('group', { name: 'Output' })).toHaveText('2', {
      timeout: 30_000,
    });
    // Shift+Enter at the end added a sixth cell; leave it, then D D deletes it.
    await expect(page.getByRole('list', { name: 'Cells' }).getByRole('listitem')).toHaveCount(6);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.keyboard.press('d');
    await expect(page.getByRole('list', { name: 'Cells' }).getByRole('listitem')).toHaveCount(5);
  });

  test('HTML with a script runs in the sandboxed output frame', async () => {
    const { page } = app;
    await cellAt(page, 4).locator('.nb-gutter').click();
    await page.keyboard.press('b');
    await page.keyboard.type('html()');
    await page.keyboard.press('Control+Enter');
    const frame = page.frameLocator('iframe[title="HTML output"]');
    await expect(frame.locator('#out')).toHaveText('from a script', { timeout: 30_000 });
    // The frame is its own origin: it can't reach Lathe's page.
    await expect(page.locator('iframe[title="HTML output"]')).toHaveAttribute(
      'sandbox',
      'allow-scripts',
    );
  });

  test('saves as nbformat, and reads it back the same', async () => {
    const { page } = app;
    await expect(page.getByRole('tab', { name: /demo\.ipynb/ })).toBeVisible();
    await page.keyboard.press('Control+S');
    await expect
      .poll(() => readFileSync(join(project, 'demo.ipynb'), 'utf8'))
      .toContain('"output_type": "error"');
    const saved = readFileSync(join(project, 'demo.ipynb'), 'utf8');
    // Jupyter's layout: one-space indents, sorted keys, lines split, a final newline.
    expect(saved.startsWith('{\n "cells": [\n  {\n   "cell_type": "code",')).toBe(true);
    expect(saved).toContain('"text": [\n      "2\\n"\n     ]');
    expect(saved).toContain('"name": "fake"');
    expect(saved.endsWith('\n "nbformat": 4,\n "nbformat_minor": 5\n}\n')).toBe(true);

    // Close it, open it again: the same cells and outputs, and saving changes nothing.
    await page.keyboard.press('Control+W');
    await openNotebook(page);
    await expect(cellAt(page, 2).locator('[data-mime="image/png"] img')).toBeVisible();
    await expect(cellAt(page, 4).getByRole('group', { name: 'Output' })).toHaveText('2');
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(500);
    expect(readFileSync(join(project, 'demo.ipynb'), 'utf8')).toBe(saved);
  });

  test('# %% cells in a Python file run into the Interactive panel', async () => {
    const { page } = app;
    await page.keyboard.press('Control+Shift+E');
    await page.getByRole('treeitem', { name: /cells\.py$/ }).dblclick();
    await expect(page.locator('.cm-cellRun').first()).toBeVisible();
    await page.locator('.cm-line', { hasText: 'print(1+1)' }).click();
    await page.keyboard.press('Shift+Enter');
    const panel = page.getByRole('log', { name: 'Interactive' });
    await expect(panel.getByRole('group', { name: 'Output' }).first()).toHaveText('2', {
      timeout: 30_000,
    });
    // The cursor moved into the next cell; Ctrl+Enter runs it where it is.
    await page.keyboard.press('Control+Enter');
    await expect(panel.locator('section')).toHaveCount(2);
    await expect(panel.locator('section').nth(1)).toContainText('cells.py:4');
  });
});
