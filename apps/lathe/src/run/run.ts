// The Run button: build the file if its language needs it, then run it in the Run terminal,
// where its output streams and you can type into it.

import type { TextDoc } from '../editor/documents';
import { saveDocument } from '../editor/documents';
import { backend, errorMessage } from '../lib/backend';
import { basename, dirname, isUnder, join, pathKey } from '../lib/paths';
import { ask } from '../services/dialogs';
import { notify } from '../services/notifications';
import { appendOutput, clearOutput } from '../services/output';
import { parseProblems, setProblems } from '../services/problems';
import { activeTab } from '../workbench/editors/store';
import { showPanel, showView } from '../workbench/layout';
import { runInTerminal } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';

interface Step {
  program: string;
  args: string[];
  env?: [string, string][];
  cwd: string;
}

export interface Plan {
  build?: Step;
  run: Step;
}

/** Languages the Run button knows how to run. */
const RUNNABLE = new Set([
  'python',
  'javascript',
  'typescript',
  'java',
  'go',
  'csharp',
  'ruby',
  'php',
  'lua',
  'powershell',
  'shellscript',
  'rust',
  'c',
  'cpp',
]);

export function canRun(languageId: string | null | undefined): boolean {
  return !!languageId && RUNNABLE.has(languageId);
}

let msvcEnv: Promise<[string, string][] | null> | null = null;

async function have(program: string): Promise<boolean> {
  return !!(await backend().toolchains.which(program));
}

/** Where a folder's programs are built: one folder each, so two main.cpp files never collide. */
function buildDir(sourceDir: string): string {
  let hash = 0x811c9dc5;
  for (const char of pathKey(sourceDir)) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  const tag = `${basename(sourceDir)
    .replace(/[^\w.-]/g, '_')
    .slice(0, 24)}-${hash.toString(16)}`;
  return join(backend().boot().dataDir, 'run', tag);
}

/** How to run (and first build) a file, or a reason it can't run. */
export async function planFor(doc: TextDoc): Promise<Plan | string> {
  const file = doc.path!;
  const cwd = dirname(file);
  const name = basename(file).replace(/\.[^.]+$/, '');
  const exe = join(buildDir(cwd), `${name}.exe`);
  const missing = (tool: string) =>
    `${tool} isn't installed. Install it from Run and debug → Toolchains.`;
  switch (doc.languageId) {
    case 'python':
      if (!(await have('python'))) return missing('Python');
      return { run: { program: 'python', args: ['-u', file], cwd } };
    case 'javascript':
    case 'typescript':
      if (!(await have('node'))) return missing('Node.js');
      return { run: { program: 'node', args: [file], cwd } };
    case 'java':
      if (!(await have('java'))) return missing('Java');
      return { run: { program: 'java', args: [file], cwd } };
    case 'go':
      if (!(await have('go'))) return missing('Go');
      return { run: { program: 'go', args: ['run', file], cwd } };
    case 'csharp':
      if (!(await have('dotnet'))) return missing('The .NET SDK');
      return { run: { program: 'dotnet', args: ['run', file], cwd } };
    case 'ruby':
    case 'php':
    case 'lua':
      if (!(await have(doc.languageId))) return missing(doc.languageId);
      return { run: { program: doc.languageId, args: [file], cwd } };
    case 'powershell':
      return {
        run: {
          program: 'powershell',
          args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
          cwd,
        },
      };
    case 'shellscript':
      if (!(await have('bash'))) return missing('Git Bash');
      return { run: { program: 'bash', args: [file], cwd } };
    case 'rust': {
      // Inside a Cargo project, `cargo run`; a loose file, rustc.
      for (let dir = cwd; ; dir = dirname(dir)) {
        if (await backend().fs.stat(join(dir, 'Cargo.toml'))) {
          return { run: { program: 'cargo', args: ['run'], cwd: dir } };
        }
        if (dirname(dir) === dir) break;
      }
      if (!(await have('rustc'))) return missing('Rust');
      return {
        build: { program: 'rustc', args: [file, '-g', '-o', exe], cwd },
        run: { program: exe, args: [], cwd },
      };
    }
    case 'c':
    case 'cpp': {
      const cpp = doc.languageId === 'cpp';
      const std = cpp ? '-std=c++20' : '-std=c17';
      for (const compiler of cpp ? ['clang++', 'g++'] : ['clang', 'gcc']) {
        if (await have(compiler)) {
          return {
            build: { program: compiler, args: [file, std, '-g', '-O0', '-o', exe], cwd },
            run: { program: exe, args: [], cwd },
          };
        }
      }
      msvcEnv ??= backend().toolchains.msvcEnv();
      const env = await msvcEnv;
      if (!env) return missing('A C/C++ compiler (LLVM, MinGW or Visual Studio Build Tools)');
      const out = dirname(exe);
      // cl.exe is found through the developer environment's PATH.
      const path = env.find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
      const cl = path
        .split(';')
        .map((dir) => join(dir, 'cl.exe'))
        .find((candidate) => /\\bin\\Hostx64\\x64\\cl\.exe$/i.test(candidate));
      return {
        build: {
          program: cl ?? 'cl',
          args: [
            '/nologo',
            '/EHsc',
            cpp ? '/std:c++20' : '/std:c17',
            '/Zi',
            '/Od',
            '/utf-8',
            file,
            `/Fe:${exe}`,
            `/Fo:${out}\\`,
            // The compiler's PDB apart from the linker's, which the debugger reads.
            `/Fd:${join(out, `${name}-cl.pdb`)}`,
            '/link',
            '/DEBUG',
          ],
          env,
          cwd,
        },
        run: { program: exe, args: [], cwd },
      };
    }
    default:
      return `Lathe doesn't know how to run ${doc.language?.name ?? 'this kind of'} files yet.`;
  }
}

/** Asks once per folder before running its code. */
export async function ensureTrusted(folder: string): Promise<boolean> {
  if (await backend().toolchains.isTrusted(folder)) return true;
  const answer = await ask({
    title: `Do you trust the code in ${basename(folder)}?`,
    message:
      'Running files, tasks and debuggers here runs its code with your permissions. Only trust folders whose code you know.',
    buttons: [
      { id: 'trust', label: 'Trust and run', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'trust') return false;
  await backend().toolchains.setTrusted(folder, true);
  return true;
}

/** Builds a file whose language needs it (with debug info); false if that failed. */
export async function buildPlan(doc: TextDoc, plan: Plan): Promise<boolean> {
  setProblems('build', []);
  if (!plan.build) return true;
  clearOutput('Run');
  appendOutput('Run', `> ${plan.build.program} ${plan.build.args.join(' ')}\n`);
  try {
    await backend()
      .fs.createDir(dirname(plan.run.program))
      .catch(() => {});
    const built = await backend().toolchains.capture({
      program: plan.build.program,
      args: plan.build.args,
      cwd: plan.build.cwd,
      env: plan.build.env ?? [],
      timeoutMs: 120_000,
    });
    appendOutput('Run', built.output);
    const problems = parseProblems(built.output, plan.build.cwd);
    setProblems('build', problems);
    if (built.code !== 0) {
      notify('error', `Building ${doc.name} failed.`, {
        detail:
          problems[0]?.message ?? (built.timedOut ? 'It took longer than two minutes.' : undefined),
        actions: [
          { label: 'Show problems', run: () => showPanel('problems') },
          { label: 'Show output', run: () => showPanel('output') },
        ],
      });
      return false;
    }
  } catch (err) {
    notify('error', `Couldn't build ${doc.name}.`, { detail: errorMessage(err) });
    return false;
  }
  return true;
}

/** Runs the active editor's file (Ctrl+F5). */
export async function runActiveFile() {
  const { doc } = activeTab();
  if (!doc) {
    notify('info', 'Open a file, then run it.');
    return;
  }
  if ((!doc.path || doc.dirty) && !(await saveDocument(doc))) return;
  const path = doc.path!;
  const root = useWorkspace.getState().root;
  const folder = root && isUnder(path, root) ? root : dirname(path);
  if (!(await ensureTrusted(folder))) return;
  const plan = await planFor(doc);
  if (typeof plan === 'string') {
    notify('warning', plan, {
      actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
    });
    return;
  }
  if (!(await buildPlan(doc, plan))) return;
  await runInTerminal({
    title: `Run: ${doc.name}`,
    program: plan.run.program,
    args: plan.run.args,
    cwd: plan.run.cwd,
    env: plan.run.env ?? [],
    tag: 'run',
  });
}
