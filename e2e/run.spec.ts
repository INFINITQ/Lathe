// The Run button, tasks and terminals against real toolchains: each hello-world reads a name
// from the Run terminal, which proves input reaches the program. A language whose toolchain
// isn't installed on this machine is skipped, not failed.

import { type Locator, type Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunningApp, launchApp } from './app';

// Each prompt and greeting names its language, so a check can't match the previous run.
const PROGRAMS: { file: string; tag: string; tool: string; source: string }[] = [
  {
    file: 'hello.py',
    tag: 'py',
    tool: 'python',
    source: 'name = input("py name? ")\nprint(f"Hello py, {name}!")\n',
  },
  {
    file: 'hello.js',
    tag: 'js',
    tool: 'node',
    source:
      "const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });\nrl.question('js name? ', (name) => {\n  console.log(`Hello js, ${name}!`);\n  rl.close();\n});\n",
  },
  {
    file: 'hello.ts',
    tag: 'ts',
    tool: 'node',
    source:
      "import { createInterface } from 'node:readline/promises';\nconst rl = createInterface({ input: process.stdin, output: process.stdout });\nconst name: string = await rl.question('ts name? ');\nconsole.log(`Hello ts, ${name}!`);\nrl.close();\n",
  },
  {
    file: 'hello.cpp',
    tag: 'cpp',
    tool: 'msvc',
    source:
      '#include <iostream>\n#include <string>\nint main() {\n  std::string name;\n  std::cout << "cpp name? " << std::flush;\n  std::getline(std::cin, name);\n  std::cout << "Hello cpp, " << name << "!" << std::endl;\n}\n',
  },
  {
    file: 'Hello.java',
    tag: 'java',
    tool: 'java',
    source:
      'import java.util.Scanner;\npublic class Hello {\n  public static void main(String[] args) {\n    System.out.print("java name? ");\n    System.out.flush();\n    String name = new Scanner(System.in).nextLine();\n    System.out.println("Hello java, " + name + "!");\n  }\n}\n',
  },
  {
    file: 'hello.rs',
    tag: 'rs',
    tool: 'rustc',
    source:
      'use std::io::{self, Write};\nfn main() {\n    print!("rs name? ");\n    io::stdout().flush().unwrap();\n    let mut name = String::new();\n    io::stdin().read_line(&mut name).unwrap();\n    println!("Hello rs, {}!", name.trim());\n}\n',
  },
];

function installed(tool: string): boolean {
  if (tool === 'msvc') {
    try {
      const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
      const found = execFileSync(
        vswhere,
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          '-property',
          'installationPath',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return found.toString().trim().length > 0;
    } catch {
      return false;
    }
  }
  try {
    execFileSync('where.exe', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lathe-run-'));
  for (const program of PROGRAMS) writeFileSync(join(dir, program.file), program.source);
  writeFileSync(join(dir, 'broken.cpp'), 'int main() {\n  return missing_name;\n}\n');
  mkdirSync(join(dir, '.lathe'));
  writeFileSync(
    join(dir, '.lathe', 'tasks.json'),
    `{
  // A comment and a trailing comma, as VS Code allows.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "say hello",
      "type": "shell",
      "command": "Write-Output \\"task-says-$(6*7)-\${workspaceFolderBasename}\\"",
      "group": { "kind": "build", "isDefault": true },
    },
    {
      "label": "report a problem",
      "type": "process",
      "command": "python",
      "args": ["-c", "print('src\\\\\\\\app.py:3:5: error: something is off')"],
      "problemMatcher": ["$gcc"],
    },
  ],
}
`,
  );
  return dir;
}

/** The visible terminal's text (xterm's DOM renderer draws rows as plain elements). */
function terminalRows(page: Page): Locator {
  return page.locator('[data-terminal-active="true"] .xterm-rows');
}

async function openFile(page: Page, name: string) {
  await page.keyboard.press('Control+P');
  await page.getByRole('combobox').fill(name);
  await expect(page.getByRole('option').first()).toContainText(name);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible();
}

test.describe('run', () => {
  test.describe.configure({ mode: 'serial' });
  let app: RunningApp;
  let project: string;

  test.beforeAll(async () => {
    project = makeProject();
    app = await launchApp({ env: { LATHE_TEST_PICK_FOLDER: project } });
    await app.page.getByRole('button', { name: 'Open folder', exact: true }).click();
    await expect(app.page.getByRole('treeitem', { name: /hello\.py$/ })).toBeVisible();
  });

  test.afterAll(async () => {
    await app?.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  let trusted = false;
  for (const program of PROGRAMS) {
    test(`runs ${program.file} and reads its input`, async () => {
      test.skip(!installed(program.tool), `${program.tool} isn't installed here`);
      test.setTimeout(120_000);
      const { page } = app;
      await openFile(page, program.file);
      await page.getByRole('button', { name: /^Run file/ }).click();
      if (!trusted) {
        await page.getByRole('button', { name: 'Trust and run' }).click();
        trusted = true;
      }
      const rows = terminalRows(page);
      await expect(rows).toContainText(`${program.tag} name?`, { timeout: 90_000 });
      await page.locator('[data-terminal-active="true"] .xterm-screen').click();
      await page.keyboard.type('Lathe');
      await page.keyboard.press('Enter');
      await expect(rows).toContainText(`Hello ${program.tag}, Lathe!`);
      await expect(rows).toContainText('[Exited with code 0.]');
    });
  }

  test('a compile error lands in Problems with its line', async () => {
    test.skip(!installed('msvc'), "MSVC isn't installed here");
    test.setTimeout(120_000);
    const { page } = app;
    await openFile(page, 'broken.cpp');
    await page.getByRole('button', { name: /^Run file/ }).click();
    if (!trusted) {
      await page.getByRole('button', { name: 'Trust and run' }).click();
      trusted = true;
    }
    await page.getByRole('tab', { name: 'Problems' }).click();
    const problems = page.getByRole('list', { name: 'Problems' });
    await expect(problems).toContainText('missing_name', { timeout: 90_000 });
    await expect(problems).toContainText('broken.cpp [2,');
    await expect(page.getByRole('button', { name: /Problems: 1 error/ })).toBeVisible();
  });

  test('Ctrl+Shift+B runs the default build task from .lathe/tasks.json', async () => {
    const { page } = app;
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Shift+B');
    if (!trusted) {
      await page.getByRole('button', { name: 'Trust and run' }).click();
      trusted = true;
    }
    const rows = terminalRows(page);
    const folder = project.split(/[\\/]/).at(-1)!;
    await expect(rows).toContainText(`task-says-42-${folder}`, { timeout: 30_000 });
    await expect(page.getByRole('listitem').filter({ hasText: 'Task: say hello' })).toBeVisible();
  });

  test('a task with a problem matcher reports what its output says', async () => {
    test.skip(!installed('python'), "python isn't installed here");
    const { page } = app;
    await page.keyboard.press('Control+Shift+P');
    await page.getByRole('combobox').fill('>run task');
    await expect(page.getByRole('option').first()).toContainText('Run task');
    await page.keyboard.press('Enter');
    await page.getByRole('combobox').fill('report');
    await expect(page.getByRole('option').first()).toContainText('report a problem');
    await page.keyboard.press('Enter');
    // Its own terminal first: the previous task's terminal also ended with code 0.
    await expect(
      page.getByRole('listitem').filter({ hasText: 'Task: report a problem' }),
    ).toBeVisible();
    await expect(terminalRows(page)).toContainText('[Exited with code 0.]', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: /Problems: 2 errors/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Problems' }).click();
    const problems = page.getByRole('list', { name: 'Problems' });
    await expect(problems).toContainText('something is off');
    await expect(problems).toContainText('src/app.py [3, 5]');
  });

  test('a new terminal runs commands in PowerShell', async () => {
    const { page } = app;
    await page.getByRole('tab', { name: 'Terminal' }).click();
    await page.getByRole('button', { name: 'New terminal' }).click();
    const rows = terminalRows(page);
    await expect(rows).toContainText('PS ', { timeout: 30_000 });
    await page.locator('[data-terminal-active="true"] .xterm-screen').click();
    await page.keyboard.type('echo ("lathe-" + (40 + 2))');
    await page.keyboard.press('Enter');
    await expect(rows).toContainText('lathe-42');
  });
});
