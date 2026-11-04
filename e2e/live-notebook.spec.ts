// Opt-in (LATHE_LIVE=1, and LATHE_LIVE_PYTHON set to a Python with ipykernel and matplotlib):
// a real IPython kernel. It prints, draws a matplotlib chart, asks for input(), gets interrupted
// in a long loop, completes a name, and restarts.

import { type Page, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

const PYTHON = process.env.LATHE_LIVE_PYTHON ?? '';

test.skip(
  process.env.LATHE_LIVE !== '1' || !PYTHON,
  'Set LATHE_LIVE=1 and LATHE_LIVE_PYTHON to a Python with ipykernel and matplotlib.',
);

const CELLS = [
  'print(1 + 1)',
  'import matplotlib.pyplot as plt\nplt.plot([1, 3, 2])\nplt.show()',
  "name = input('Name? ')\nprint('hi', name)",
  'import time\nfor i in range(400):\n    time.sleep(0.05)',
  'import os\nos.pa',
];

const cellAt = (page: Page, n: number) =>
  page.getByRole('list', { name: 'Cells' }).getByRole('listitem').nth(n);

test.describe('live notebook', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;
  let jupyter: string;

  test.beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'lathe-live-nb-'));
    writeFileSync(
      join(project, 'live.ipynb'),
      JSON.stringify({
        cells: CELLS.map((source, i) => ({
          cell_type: 'code',
          id: `live000${i}`,
          metadata: {},
          source,
          execution_count: null,
          outputs: [],
        })),
        metadata: {
          kernelspec: { display_name: 'Live Python', language: 'python', name: 'livepy' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    jupyter = mkdtempSync(join(tmpdir(), 'lathe-live-jupyter-'));
    mkdirSync(join(jupyter, 'kernels', 'livepy'), { recursive: true });
    writeFileSync(
      join(jupyter, 'kernels', 'livepy', 'kernel.json'),
      JSON.stringify({
        argv: [PYTHON, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        display_name: 'Live Python',
        language: 'python',
      }),
    );
    app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project, JUPYTER_PATH: jupyter } });
    const { page } = app;
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await page.getByRole('treeitem', { name: /live\.ipynb$/ }).dblclick();
    await expect(page.getByRole('list', { name: 'Cells' })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    for (const dir of [project, jupyter]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('prints from a real kernel', async () => {
    const { page } = app;
    await cellAt(page, 0).getByRole('button', { name: 'Run cell 1' }).click();
    await expect(cellAt(page, 0).getByRole('group', { name: 'Output' })).toHaveText('2', {
      timeout: 60_000,
    });
  });

  test('draws a matplotlib chart', async () => {
    const { page } = app;
    await cellAt(page, 1).getByRole('button', { name: 'Run cell 2' }).click();
    await expect(cellAt(page, 1).locator('[data-mime="image/png"] img')).toBeVisible({
      timeout: 60_000,
    });
  });

  test('answers input()', async () => {
    const { page } = app;
    await cellAt(page, 2).getByRole('button', { name: 'Run cell 3' }).click();
    const quick = page.getByRole('dialog', { name: 'Quick input' });
    await expect(quick).toBeVisible({ timeout: 20_000 });
    await quick.getByRole('combobox').fill('Lathe');
    await page.keyboard.press('Enter');
    await expect(cellAt(page, 2).getByRole('group', { name: 'Output' })).toContainText('hi Lathe');
  });

  test('interrupts a long loop', async () => {
    const { page } = app;
    await cellAt(page, 3).getByRole('button', { name: 'Run cell 4' }).click();
    await expect(page.getByRole('button', { name: /Kernel Live Python: busy/ })).toBeVisible();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Interrupt the kernel' }).click();
    await expect(cellAt(page, 3).locator('[data-error="KeyboardInterrupt"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('completes names from the kernel', async () => {
    const { page } = app;
    await cellAt(page, 4).locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+Space');
    await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('path', {
      timeout: 20_000,
    });
    await page.keyboard.press('Escape');
  });

  test('restarts the kernel', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Restart the kernel' }).click();
    await expect(page.getByRole('button', { name: 'Kernel Live Python: idle' })).toBeVisible({
      timeout: 60_000,
    });
    await cellAt(page, 0).getByRole('button', { name: 'Run cell 1' }).click();
    await expect(cellAt(page, 0).getByLabel('Execution count 1')).toBeVisible({ timeout: 30_000 });
  });
});
