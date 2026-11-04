// Tasks: named commands that build, test or run a project. They come from .lathe/tasks.json, the
// common fields of .vscode/tasks.json, package.json scripts and Cargo. Each task runs in its own
// terminal, and a task with a problem matcher turns compiler errors into Problems when it ends.

import { getActiveView } from '../editor/active';
import { backend, errorMessage } from '../lib/backend';
import { parseJsonc } from '../lib/jsonc';
import { basename, dirname, isAbsolute, join, relative, resolve } from '../lib/paths';
import { notify } from '../services/notifications';
import { parseProblems, setProblems } from '../services/problems';
import { activeTab, openPath } from '../workbench/editors/store';
import { quickPick } from '../workbench/quickinput/store';
import { runInTerminal, terminalExited } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { ensureTrusted } from './run';

export interface Task {
  label: string;
  source: 'lathe' | 'vscode' | 'npm' | 'cargo';
  /** shell: a command line for the shell; process: a program and its arguments. */
  type: 'shell' | 'process';
  command: string;
  args: string[];
  /** Variables are filled in when the task runs. */
  cwd: string | null;
  env: Record<string, string>;
  shell: { executable: string; args: string[] } | null;
  group: 'build' | 'test' | null;
  isDefault: boolean;
  problems: boolean;
  dependsOn: string[];
  detail: string | null;
  hidden: boolean;
}

export const SOURCE_NAMES: Record<Task['source'], string> = {
  lathe: '.lathe/tasks.json',
  vscode: '.vscode/tasks.json',
  npm: 'package.json',
  cargo: 'Cargo',
};

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A command or argument: a string, or VS Code's { value, quoting } form. */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ');
  return isObject(value) ? str(value.value) : null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** One task from a tasks.json, or null if Lathe can't run its kind. */
export function taskFromJson(
  raw: Raw,
  source: 'lathe' | 'vscode',
  packageManager = 'npm',
): Task | null {
  // Lathe only runs on Windows, so the "windows" overrides always apply.
  const win = isObject(raw.windows) ? raw.windows : {};
  const options = {
    ...(isObject(raw.options) ? raw.options : {}),
    ...(isObject(win.options) ? win.options : {}),
  };
  const task: Raw = { ...raw, ...win };
  const kind = str(task.type) ?? 'shell';
  let label = str(task.label) ?? str(task.taskName);
  let command = text(task.command);
  let args = Array.isArray(task.args)
    ? task.args.map(text).filter((a): a is string => a !== null)
    : [];
  let type: Task['type'] = kind === 'process' ? 'process' : 'shell';
  let cwd = str(options.cwd);
  let problems = Array.isArray(task.problemMatcher)
    ? task.problemMatcher.length > 0
    : !!task.problemMatcher;
  if (kind === 'npm') {
    const script = str(task.script);
    if (!script) return null;
    command = `${packageManager} run ${script}`;
    args = [];
    label ??= `npm: ${script}`;
    cwd ??= str(task.path);
  } else if (kind === 'cargo') {
    const sub = command ?? 'build';
    command = 'cargo';
    args = [sub, ...args];
    type = 'process';
    label ??= `cargo ${sub}`;
    problems = true;
  } else if (kind === 'typescript') {
    const project = str(task.tsconfig) ?? 'tsconfig.json';
    command = `npx tsc -p ${quoteFor('powershell', project)}${task.option === 'watch' ? ' --watch' : ''}`;
    args = [];
    label ??= `tsc: ${task.option === 'watch' ? 'watch' : 'build'} - ${project}`;
    problems = true;
  } else if (kind !== 'shell' && kind !== 'process') {
    return null;
  }
  const dependsOn = (Array.isArray(task.dependsOn) ? task.dependsOn : [task.dependsOn])
    .map((d) => (typeof d === 'string' ? d : isObject(d) ? str(d.label) : null))
    .filter((d): d is string => !!d);
  if (!command && !dependsOn.length) return null;
  label ??= command ?? 'task';
  let group: Task['group'] = null;
  let isDefault = false;
  const rawGroup = task.group;
  const groupKind = isObject(rawGroup) ? str(rawGroup.kind) : str(rawGroup);
  if (groupKind === 'build' || groupKind === 'test') group = groupKind;
  if (isObject(rawGroup))
    isDefault = rawGroup.isDefault === true || typeof rawGroup.isDefault === 'string';
  const shell =
    isObject(options.shell) && str(options.shell.executable)
      ? {
          executable: str(options.shell.executable)!,
          args: Array.isArray(options.shell.args)
            ? options.shell.args.filter((a) => typeof a === 'string')
            : [],
        }
      : null;
  return {
    label,
    source,
    type,
    command: command ?? '',
    args,
    cwd,
    env: stringRecord(options.env),
    shell,
    group,
    isDefault,
    problems,
    dependsOn,
    detail: str(task.detail),
    hidden: task.hide === true,
  };
}

async function readJson(path: string): Promise<unknown> {
  if (!(await backend().fs.stat(path))) return null;
  const { text: content } = await backend().fs.readText(path);
  return parseJsonc(content);
}

async function packageManagerIn(root: string, pkg: Raw | null): Promise<string> {
  const declared = str(pkg?.packageManager)?.split('@')[0];
  if (declared) return declared;
  const locks: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ];
  for (const [file, manager] of locks) {
    if (await backend().fs.stat(join(root, file))) return manager;
  }
  return 'npm';
}

/** Every task for a folder: tasks.json files first, then detected scripts and Cargo commands. */
export async function loadTasks(root: string): Promise<Task[]> {
  const tasks: Task[] = [];
  const seen = new Set<string>();
  const push = (task: Task | null) => {
    if (!task || seen.has(task.label)) return;
    seen.add(task.label);
    tasks.push(task);
  };
  let pkg: Raw | null = null;
  try {
    const value = await readJson(join(root, 'package.json'));
    pkg = isObject(value) ? value : null;
  } catch {
    // A broken package.json just has no scripts.
  }
  const manager = await packageManagerIn(root, pkg);
  for (const [file, source] of [
    ['.lathe\\tasks.json', 'lathe'],
    ['.vscode\\tasks.json', 'vscode'],
  ] as const) {
    try {
      const value = await readJson(join(root, file));
      const list = isObject(value) && Array.isArray(value.tasks) ? value.tasks : [];
      for (const raw of list) if (isObject(raw)) push(taskFromJson(raw, source, manager));
    } catch (err) {
      notify('warning', `Couldn't read ${file}.`, { detail: errorMessage(err) });
    }
  }
  const scripts = isObject(pkg?.scripts) ? stringRecord(pkg.scripts) : {};
  for (const [name, script] of Object.entries(scripts)) {
    push({
      label: `${manager}: ${name}`,
      source: 'npm',
      type: 'shell',
      command: `${manager} run ${name}`,
      args: [],
      cwd: null,
      env: {},
      shell: null,
      group: name === 'build' ? 'build' : name === 'test' ? 'test' : null,
      isDefault: false,
      problems: /\b(build|lint|check|typecheck|tsc)\b/.test(name),
      dependsOn: [],
      detail: script,
      hidden: false,
    });
  }
  if (await backend().fs.stat(join(root, 'Cargo.toml'))) {
    for (const sub of ['build', 'check', 'run', 'test', 'clippy']) {
      push({
        label: `cargo ${sub}`,
        source: 'cargo',
        type: 'process',
        command: 'cargo',
        args: [sub],
        cwd: null,
        env: {},
        shell: null,
        group: sub === 'build' ? 'build' : sub === 'test' ? 'test' : null,
        isDefault: false,
        problems: true,
        dependsOn: [],
        detail: null,
        hidden: false,
      });
    }
  }
  return tasks;
}

type ShellKind = 'powershell' | 'cmd' | 'posix';

function shellKind(executable: string): ShellKind {
  const name = basename(executable).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return 'cmd';
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return 'powershell';
  return 'posix';
}

/** Quotes an argument for a shell when it has spaces (as VS Code does), else leaves it alone. */
function quoteFor(shell: ShellKind, arg: string): string {
  if (!/\s/.test(arg) || /^(['"]).*\1$/.test(arg)) return arg;
  if (shell === 'powershell') return `'${arg.replace(/'/g, "''")}'`;
  if (shell === 'cmd') return `"${arg}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** relative() writes forward slashes for display; commands get Windows' own. */
const windowsPath = (path: string) => path.replaceAll('/', '\\');

interface Context {
  root: string;
  file: string | null;
  shell: ShellKind | null;
}

/** Fills in ${workspaceFolder}, ${file} and VS Code's other variables. */
export function substitute(value: string, ctx: Context): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const file = ctx.file;
    const base = file ? basename(file) : '';
    switch (name) {
      case 'workspaceFolder':
      case 'workspaceRoot':
      case 'fileWorkspaceFolder':
      case 'cwd':
        return ctx.root;
      case 'workspaceFolderBasename':
        return basename(ctx.root);
      case 'file':
        return file ?? '';
      case 'fileBasename':
        return base;
      case 'fileBasenameNoExtension':
        return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
      case 'fileExtname':
        return base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
      case 'fileDirname':
        return file ? dirname(file) : '';
      case 'fileDirnameBasename':
        return file ? basename(dirname(file)) : '';
      case 'relativeFile':
        return file ? windowsPath(relative(ctx.root, file)) : '';
      case 'relativeFileDirname':
        return file ? windowsPath(relative(ctx.root, dirname(file))) : '';
      case 'lineNumber': {
        const view = getActiveView();
        return view ? String(view.state.doc.lineAt(view.state.selection.main.head).number) : '1';
      }
      case 'selectedText': {
        const view = getActiveView();
        return view
          ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
          : '';
      }
      case 'pathSeparator':
      case '/':
        return '\\';
    }
    if (name.startsWith('env:')) {
      const variable = name.slice(4);
      if (ctx.shell === 'powershell') return `$env:${variable}`;
      if (ctx.shell === 'cmd') return `%${variable}%`;
      if (ctx.shell === 'posix') return `$${variable}`;
      return '';
    }
    return whole;
  });
}

const FILE_VARIABLE =
  /\$\{(file|fileBasename|fileBasenameNoExtension|fileExtname|fileDirname|fileDirnameBasename|relativeFile|relativeFileDirname)\}/;

function needsFile(task: Task): boolean {
  return [task.command, ...task.args, task.cwd ?? ''].some((part) => FILE_VARIABLE.test(part));
}

/** UTF-16LE, base64: PowerShell's -EncodedCommand, which no quoting can break. */
function encodeCommand(script: string): string {
  let binary = '';
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    binary += String.fromCharCode(code & 0xff, code >> 8);
  }
  return btoa(binary);
}

let defaultShell: Promise<string> | null = null;

/** The program and arguments that run a task, with every variable filled in. */
export async function launchFor(
  task: Task,
  root: string,
  file: string | null,
): Promise<{ program: string; args: string[]; cwd: string; env: [string, string][] }> {
  defaultShell ??= backend()
    .toolchains.which('pwsh')
    .then((pwsh) => (pwsh ? 'pwsh' : 'powershell'))
    .catch(() => 'powershell');
  const shellProgram =
    task.type === 'shell' ? (task.shell?.executable ?? (await defaultShell)) : null;
  const kind = shellProgram ? shellKind(shellProgram) : null;
  const ctx: Context = { root, file, shell: kind };
  const cwdText = task.cwd ? substitute(task.cwd, ctx) : root;
  const cwd = isAbsolute(cwdText) ? cwdText : resolve(root, cwdText);
  const env = Object.entries(task.env).map(([k, v]): [string, string] => [
    k,
    substitute(v, { ...ctx, shell: null }),
  ]);
  if (!shellProgram || !kind) {
    return {
      program: substitute(task.command, ctx),
      args: task.args.map((a) => substitute(a, ctx)),
      cwd,
      env,
    };
  }
  const command = substitute(task.command, ctx);
  const args = task.args.map((a) => quoteFor(kind, substitute(a, ctx)));
  const commandText =
    kind === 'powershell' && /^[a-zA-Z]:\\/.test(command) && /\s/.test(command)
      ? `& ${quoteFor(kind, command)}`
      : command;
  const line = [commandText, ...args].join(' ');
  if (task.shell) return { program: shellProgram, args: [...task.shell.args, line], cwd, env };
  if (kind === 'powershell') {
    return {
      program: shellProgram,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodeCommand(line),
      ],
      cwd,
      env,
    };
  }
  return {
    program: shellProgram,
    args: kind === 'cmd' ? ['/d', '/s', '/c', line] : ['-c', line],
    cwd,
    env,
  };
}

let lastTask: string | null = null;

/** Runs a task (its dependencies first, one after another); resolves with its exit code. */
export async function runTask(task: Task, chain: string[] = []): Promise<number | null> {
  const root = useWorkspace.getState().root;
  if (!root) {
    notify('info', 'Open a folder to run its tasks.');
    return null;
  }
  if (chain.includes(task.label)) {
    notify('error', `The task "${task.label}" depends on itself.`);
    return null;
  }
  if (!chain.length && !(await ensureTrusted(root))) return null;
  if (task.dependsOn.length) {
    const all = await loadTasks(root);
    for (const label of task.dependsOn) {
      const dependency = all.find((t) => t.label === label);
      if (!dependency) {
        notify('error', `The task "${task.label}" needs "${label}", which isn't defined.`);
        return null;
      }
      const code = await runTask(dependency, [...chain, task.label]);
      if (code !== 0) return code;
    }
  }
  if (!task.command) return 0;
  const file = activeTab().doc?.path ?? null;
  if (!file && needsFile(task)) {
    notify('info', `The task "${task.label}" works on the open file: open one, then run it.`);
    return null;
  }
  const source = `task:${task.label}`;
  setProblems(source, []);
  let launch;
  try {
    launch = await launchFor(task, root, file);
  } catch (err) {
    notify('error', `Couldn't start the task "${task.label}".`, { detail: errorMessage(err) });
    return null;
  }
  const info = await runInTerminal({
    title: `Task: ${task.label}`,
    program: launch.program,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    tag: source,
  });
  if (!info) return null;
  if (!chain.length) lastTask = task.label;
  const { code, text: output } = await terminalExited(info.id);
  if (task.problems) setProblems(source, parseProblems(output, launch.cwd, source));
  return code;
}

async function currentRoot(): Promise<string | null> {
  const root = useWorkspace.getState().root;
  if (!root) notify('info', 'Open a folder to run its tasks.');
  return root;
}

/** Asks which task to run; `group` narrows the list to build or test tasks when there are any. */
export async function pickTask(tasks: Task[], group?: 'build' | 'test'): Promise<Task | null> {
  const shown = tasks.filter((t) => !t.hidden);
  const inGroup = group ? shown.filter((t) => t.group === group) : [];
  const list = inGroup.length ? inGroup : shown;
  if (!list.length) {
    notify('info', 'This folder has no tasks yet.', {
      actions: [{ label: 'Configure tasks', run: () => void configureTasks() }],
    });
    return null;
  }
  const picked = await quickPick(
    list.map((t, i) => ({
      id: String(i),
      label: t.label,
      description: t.detail ?? [t.command, ...t.args].join(' '),
      hint: SOURCE_NAMES[t.source],
    })),
    {
      placeholder:
        group === 'build'
          ? 'Pick the build task to run'
          : group === 'test'
            ? 'Pick the test task to run'
            : 'Pick a task to run',
    },
  );
  return picked ? (list[Number(picked.id)] ?? null) : null;
}

export async function runTaskCommand() {
  const root = await currentRoot();
  if (!root) return;
  const task = await pickTask(await loadTasks(root));
  if (task) void runTask(task);
}

/** Ctrl+Shift+B (and the test equivalent): the default task of the group, or a choice. */
export async function runGroupTask(group: 'build' | 'test') {
  const root = await currentRoot();
  if (!root) return;
  const tasks = await loadTasks(root);
  const inGroup = tasks.filter((t) => t.group === group && !t.hidden);
  const chosen =
    inGroup.find((t) => t.isDefault) ??
    (inGroup.length === 1 ? inGroup[0] : await pickTask(tasks, group));
  if (chosen) void runTask(chosen);
}

export async function rerunLastTask() {
  const root = await currentRoot();
  if (!root) return;
  const task = lastTask ? (await loadTasks(root)).find((t) => t.label === lastTask) : null;
  if (task) void runTask(task);
  else void runTaskCommand();
}

const TEMPLATE = `{
  // Tasks for this folder. Run one with "Run task", or press Ctrl+Shift+B for the default
  // build task. Variables: \${workspaceFolder}, \${file}, \${fileBasenameNoExtension},
  // \${fileDirname}, \${env:NAME}… (VS Code's tasks.json format works here too.)
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "echo Building \${workspaceFolderBasename}",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": ["$gcc"]
    }
  ]
}
`;

/** Opens .lathe/tasks.json, creating it from a template first if it's not there. */
export async function configureTasks() {
  const root = await currentRoot();
  if (!root) return;
  const path = join(root, '.lathe', 'tasks.json');
  try {
    if (!(await backend().fs.stat(path))) {
      if (!(await backend().fs.stat(dirname(path)))) await backend().fs.createDir(dirname(path));
      const format = await backend().fs.newFileFormat(path);
      await backend().fs.writeText(path, TEMPLATE, format, null, false);
    }
    await openPath(path);
  } catch (err) {
    notify('error', "Couldn't create .lathe/tasks.json.", { detail: errorMessage(err) });
  }
}
