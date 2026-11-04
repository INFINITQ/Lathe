// Milestone screenshots of the real app (not part of the normal run):
//   LATHE_SCREENSHOT=docs/screenshots/m1.png pnpm e2e screenshot
// LATHE_SCREENSHOT_SCENE picks what's on screen: "editor" (the default), "search", "lsp", "scm",
// "debug" (paused in a loop with debugpy from the live tests' downloads), "notebook" (a real
// kernel from LATHE_LIVE_PYTHON draws a chart), "run" (the Run view with a program that has read
// input in the Run terminal), "settings", "keybindings", or "preview" (README.md beside its
// Markdown preview).
import { type Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launchApp } from './app';

const target = process.env.LATHE_SCREENSHOT;
const scene = process.env.LATHE_SCREENSHOT_SCENE ?? 'editor';

test.skip(!target, 'Set LATHE_SCREENSHOT to a .png path to take the milestone screenshot.');

/** Hovers the call to fib in fib's last line, and waits for basedpyright's tooltip. */
async function hoverFib(page: Page) {
  const box = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) =>
      l.textContent?.includes('return fib(n - 1)'),
    );
    const walker = line && document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker?.nextNode(); node; node = walker!.nextNode()) {
      const at = node.textContent?.indexOf('fib') ?? -1;
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 3);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  });
  if (!box) return;
  await page.mouse.move(5, 300);
  await page.mouse.move(box.x, box.y);
  await expect(page.locator('.cm-tooltip-hover')).toContainText('Fibonacci', { timeout: 20_000 });
}

test('milestone screenshot', async () => {
  const project = mkdtempSync(join(tmpdir(), 'fib-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(
    join(project, 'src', 'main.py'),
    [
      'from functools import cache',
      '',
      '',
      '@cache',
      'def fib(n: int) -> int:',
      '    """The n-th Fibonacci number."""',
      '    if n < 2:',
      '        return n',
      '    return fib(n - 1) + fib(n - 2)',
      '',
      '',
      'def main() -> None:',
      '    count = int(input("How many? "))',
      ...(scene === 'lsp' ? ['    label: str = fib(count)', '    print(label)'] : []),
      '    for i in range(count):',
      '        print(f"fib({i}) = {fib(i)}")',
      '',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(project, 'src', 'fib.cpp'),
    '#include <iostream>\n#include <vector>\n\nint main() {\n    std::vector<long long> f{0, 1};\n    for (int i = 2; i < 50; ++i) f.push_back(f[i - 1] + f[i - 2]);\n    for (auto x : f) std::cout << x << "\\n";\n}\n',
  );
  writeFileSync(
    join(project, 'README.md'),
    [
      '# fib',
      '',
      'Three ways to count rabbits, from the slow one to the **fast** one.',
      '',
      '## Run it',
      '',
      '```sh',
      'python src/main.py',
      '```',
      '',
      '| Way | Time for fib(32) |',
      '| --- | --- |',
      '| Recursion | 0.62 s |',
      '| `@cache` | 0.00002 s |',
      '| C++ | 0.004 s |',
      '',
      '> Each pair of rabbits makes a new pair every month,',
      '> starting from their second month.',
      '',
      '- [x] Python',
      '- [x] C++',
      '- [ ] Rust',
      '',
      'See [the C++ one](src/fib.cpp).',
      '',
    ].join('\n'),
  );
  writeFileSync(join(project, '.gitignore'), 'build/\n__pycache__/\n');
  mkdirSync(join(project, '.lathe'));
  writeFileSync(
    join(project, '.lathe', 'tasks.json'),
    JSON.stringify(
      {
        version: '2.0.0',
        tasks: [
          {
            label: 'build fib.cpp',
            type: 'shell',
            command: 'cl /nologo /EHsc src\\fib.cpp',
            group: { kind: 'build', isDefault: true },
            problemMatcher: ['$msCompile'],
          },
          { label: 'test', type: 'shell', command: 'python -m pytest', group: 'test' },
          { label: 'format', type: 'shell', command: 'ruff format .' },
        ],
      },
      null,
      2,
    ),
  );
  if (scene === 'scm') {
    // A repository with a commit, then some work on top of it.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Lathe');
    git('config', 'user.email', 'lathe@example.invalid');
    git('add', '-A');
    git('commit', '-q', '-m', 'Count rabbits');
    const main = join(project, 'src', 'main.py');
    const text = readFileSync(main, 'utf8')
      .replace('The n-th Fibonacci number.', 'The n-th Fibonacci number, memoised.')
      .replace(
        '    for i in range(count):',
        '    print("Fibonacci numbers:")\n    for i in range(count):',
      );
    writeFileSync(main, text);
    writeFileSync(
      join(project, 'src', 'fast.py'),
      'def fib(n: int) -> int:\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n',
    );
  }
  let jupyter: string | null = null;
  if (scene === 'notebook') {
    // A real kernel (LATHE_LIVE_PYTHON: a Python with ipykernel and matplotlib).
    const python = process.env.LATHE_LIVE_PYTHON;
    if (!python) throw new Error('The notebook scene needs LATHE_LIVE_PYTHON.');
    jupyter = mkdtempSync(join(tmpdir(), 'lathe-shot-jupyter-'));
    mkdirSync(join(jupyter, 'kernels', 'python3'), { recursive: true });
    writeFileSync(
      join(jupyter, 'kernels', 'python3', 'kernel.json'),
      JSON.stringify({
        argv: [python, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        display_name: 'Python 3 (ipykernel)',
        language: 'python',
      }),
    );
    const code = (source: string) => ({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source,
    });
    writeFileSync(
      join(project, 'growth.ipynb'),
      JSON.stringify({
        cells: [
          {
            cell_type: 'markdown',
            metadata: {},
            source:
              '# How fast does fib grow?\n\nThe ratio of neighbours tends to the golden ratio, **φ ≈ 1.618**.',
          },
          code(
            [
              'from functools import cache',
              '',
              '@cache',
              'def fib(n: int) -> int:',
              '    return n if n < 2 else fib(n - 1) + fib(n - 2)',
              '',
              'ratios = [fib(n + 1) / fib(n) for n in range(1, 20)]',
              "print(f'after 19 steps: {ratios[-1]:.6f}')",
            ].join('\n'),
          ),
          code(
            [
              'import matplotlib.pyplot as plt',
              '',
              "grey = '#8a8a90'",
              "plt.rcParams.update({'figure.facecolor': 'none', 'axes.facecolor': 'none',",
              "                     'text.color': grey, 'axes.labelcolor': grey, 'xtick.color': grey,",
              "                     'ytick.color': grey, 'axes.edgecolor': '#55555a'})",
              'plt.figure(figsize=(6.4, 2.4))',
              "plt.plot(range(1, 20), ratios, marker='o', markersize=4, color='#84cc16')",
              "plt.axhline(1.6180339887, color=grey, linestyle='--', linewidth=1)",
              "plt.title('fib(n + 1) / fib(n)')",
              'plt.tight_layout()',
              'plt.show()',
            ].join('\n'),
          ),
          code('{n: fib(n) for n in range(30, 34)}'),
        ],
        metadata: {
          kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' },
        },
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
  }
  const app = await launchApp({
    lsp: scene === 'lsp',
    env: {
      // The plugins scene installs the two samples from their folders after opening the project.
      LATHE_TEST_PICK_FOLDER:
        scene === 'plugins'
          ? [project, resolve('plugins', 'word-count'), resolve('plugins', 'sunset')].join(';')
          : project,
      // The live tests' downloads (basedpyright), for the language server scene.
      LATHE_TEST_TOOLS_DIR: join(tmpdir(), 'lathe-live-tools'),
      ...(jupyter ? { JUPYTER_PATH: jupyter } : {}),
    },
  });
  try {
    const { page } = app;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await page.getByRole('treeitem', { name: /src$/ }).click();
    await page.getByRole('treeitem', { name: /fib\.cpp$/ }).dblclick();
    await page.getByRole('treeitem', { name: /main\.py$/ }).dblclick();
    await expect(page.locator('.cm-content')).toContainText('def fib');
    await page.locator('.cm-content').click({ position: { x: 300, y: 120 } });
    if (scene === 'run') {
      await page.keyboard.press('Control+Shift+D');
      await expect(page.getByRole('region', { name: 'Toolchains' })).toContainText('Python 3', {
        timeout: 30_000,
      });
      await page.getByRole('button', { name: 'Run file (Ctrl+F5)' }).click();
      await page.getByRole('button', { name: 'Trust and run' }).click();
      const rows = page.locator('[data-terminal-active="true"] .xterm-rows');
      await expect(rows).toContainText('How many?', { timeout: 30_000 });
      await page.locator('[data-terminal-active="true"] .xterm-screen').click();
      await page.keyboard.type('12');
      await page.keyboard.press('Enter');
      await expect(rows).toContainText('fib(11) = 89');
      await page.locator('.cm-content').click({ position: { x: 300, y: 120 } });
    }
    if (scene === 'scm') {
      await page.keyboard.press('Control+Shift+G');
      await page.getByRole('textbox', { name: 'Commit message' }).fill('Faster fib, and a heading');
      await page
        .getByRole('group', { name: 'Changes' })
        .getByRole('treeitem', { name: /^main\.py src M/ })
        .click();
      await expect(page.locator('.cm-mergeView')).toBeVisible();
    }
    if (scene === 'debug') {
      // A breakpoint in fib's loop; debugpy runs main.py in a terminal, which reads the count.
      const line = await page.locator('.cm-line', { hasText: 'print(f"fib(' }).boundingBox();
      const gutter = await page.locator('.cm-breakpointGutter').first().boundingBox();
      await page.mouse.click(gutter!.x + gutter!.width / 2, line!.y + line!.height / 2);
      await page.getByRole('button', { name: 'Debug this file' }).click();
      await page.getByRole('button', { name: 'Trust and run' }).click();
      const rows = page.locator('[data-terminal-active="true"] .xterm-rows');
      await expect(rows).toContainText('How many?', { timeout: 60_000 });
      await page.locator('[data-terminal-active="true"] .xterm-screen').click();
      await page.keyboard.type('8');
      await page.keyboard.press('Enter');
      await expect(page.locator('.cm-debugStopped')).toHaveCount(1, { timeout: 30_000 });
      await page.keyboard.press('Control+Shift+D');
      const variables = page.getByRole('tree', { name: 'Variables' });
      for (const i of [1, 2, 3]) {
        await page.getByRole('button', { name: /^Continue/ }).click();
        await expect(variables.getByRole('treeitem', { name: `i = ${i}` })).toBeVisible();
      }
      await page.getByRole('region', { name: 'Watch' }).hover();
      await page.getByRole('button', { name: 'Add expression' }).click();
      await page.getByRole('textbox', { name: 'Expression to watch' }).fill('fib(i + 1)');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('tree', { name: 'Watch' })).toContainText('3');
    }
    if (scene === 'plugins') {
      for (const name of [/Install Word count/, /Install Sunset/]) {
        await page.keyboard.press('Control+Shift+X');
        await page.getByRole('button', { name: 'Install a plugin' }).click();
        await page.getByRole('menuitem', { name: 'Install from a folder…' }).click();
        await page
          .getByRole('alertdialog', { name })
          .getByRole('button', { name: 'Install' })
          .click();
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
      }
      await page.getByRole('tab', { name: /main\.py/ }).click();
      await expect(page.locator('[data-plugin-item^="lathe.word-count:"]')).toBeVisible({
        timeout: 20_000,
      });
      const dismiss = page.getByRole('region', { name: 'Notifications' }).getByRole('button', {
        name: 'Dismiss',
      });
      while (await dismiss.count()) await dismiss.first().click();
    }
    if (scene === 'notebook') {
      await page.keyboard.press('Control+Shift+E');
      await page.getByRole('treeitem', { name: /growth\.ipynb$/ }).dblclick();
      await page.getByRole('button', { name: 'Run all' }).click();
      await expect(page.locator('[data-mime="image/png"] img')).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole('list', { name: 'Cells' }).getByRole('listitem').nth(3),
      ).toContainText('832040');
    }
    if (scene === 'settings') {
      await page.keyboard.press('Control+,');
      await expect(page.locator('[data-editor="settings"]')).toBeVisible();
    }
    if (scene === 'keybindings') {
      await page.keyboard.press('Control+K');
      await page.keyboard.press('Control+S');
      const editor = page.locator('[data-editor="keybindings"]');
      await editor.getByRole('searchbox').fill('view');
      await editor.locator('tbody tr').first().click();
    }
    if (scene === 'preview') {
      await page.keyboard.press('Control+Shift+E');
      await page.getByRole('treeitem', { name: /README\.md$/ }).dblclick();
      await page
        .locator('.cm-content')
        .first()
        .click({ position: { x: 200, y: 40 } });
      await page.keyboard.press('Control+K');
      await page.keyboard.press('v');
      await expect(page.locator('[data-editor="preview"] h1')).toBeVisible();
    }
    if (scene === 'search') {
      // Search with a replace preview, and the cursor inside fib (the breadcrumbs show it).
      await page.locator('.cm-content').click({ position: { x: 320, y: 160 } });
      await page.keyboard.press('Control+Shift+H');
      await page.getByRole('textbox', { name: 'Search' }).fill('fib');
      await page.getByRole('textbox', { name: 'Replace' }).fill('fibonacci');
      await expect(page.locator('[data-view="search"] [role="status"]')).toHaveAttribute(
        'data-running',
        'false',
      );
      await page
        .getByRole('tree', { name: 'Search results' })
        .getByRole('treeitem')
        .filter({ hasText: 'def fib' })
        .click();
    }
    if (scene === 'lsp') {
      // basedpyright (from the live tests' downloads): a hover, an error, the outline.
      await expect(
        page.getByRole('button', { name: 'Language server basedpyright: ready' }),
      ).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole('button', { name: 'Outline' }).click();
      await expect(page.getByRole('button', { name: /Problems: 1 error/ })).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole('button', { name: /Problems: 1 error/ }).click();
      await hoverFib(page);
    }
    await page.waitForTimeout(800);
    mkdirSync(dirname(target!), { recursive: true });
    // Both themes: dark first (Mono's signature look), then light.
    // The plugins scene shows the Sunset plugin's theme in dark, and Mono in light.
    const colourTheme = async (name: RegExp) => {
      await page.keyboard.press('Control+Shift+P');
      await page
        .getByRole('dialog', { name: 'Quick input' })
        .getByRole('combobox')
        .fill('>Colour theme');
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Quick input' }).getByRole('option', { name }).click();
    };
    for (const theme of ['dark', 'light'] as const) {
      if (scene === 'plugins' && theme === 'light') await colourTheme(/^Mono/);
      await page.keyboard.press('Control+Shift+P');
      await page
        .getByRole('dialog', { name: 'Quick input' })
        .getByRole('combobox')
        .fill(`>theme: ${theme}`);
      await page.keyboard.press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      if (scene === 'plugins' && theme === 'dark') await colourTheme(/^Sunset/);
      if (scene === 'lsp') await hoverFib(page);
      else if (scene === 'notebook') await page.getByRole('heading', { name: /How fast/ }).click();
      else if (scene === 'settings' || scene === 'keybindings') await page.mouse.move(5, 300);
      else
        await page
          .locator('.cm-content')
          .first()
          .click({ position: { x: 300, y: 120 } });
      await page.waitForTimeout(500);
      await page.screenshot({ path: target!.replace(/\.png$/, `-${theme}.png`) });
    }
  } finally {
    await app.close();
    rmSync(project, { recursive: true, force: true });
    if (jupyter) rmSync(jupyter, { recursive: true, force: true });
  }
});
