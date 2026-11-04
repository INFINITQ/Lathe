// Debug configurations: .lathe/launch.json and .vscode/launch.json (JSON with comments, VS Code's
// format), and the one "Debug this file" makes up for the active file, building it first when its
// language needs that.

import type { TextDoc } from '../editor/documents';
import { backend, errorMessage } from '../lib/backend';
import { parseJsonc } from '../lib/jsonc';
import { basename, dirname, join } from '../lib/paths';
import { notify } from '../services/notifications';
import { appendOutput, clearOutput } from '../services/output';
import { buildPlan, planFor } from '../run/run';
import { activeTab, openPath } from '../workbench/editors/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { adapterForLanguage } from './adapters';
import type { LaunchConfig } from './store';

export interface FoundConfig {
  config: LaunchConfig;
  /** The launch.json it came from. */
  file: string;
}

/** The configurations in a folder's launch.json files (.lathe first; one name, one entry). */
export async function loadConfigurations(root: string): Promise<FoundConfig[]> {
  const found: FoundConfig[] = [];
  const names = new Set<string>();
  for (const dir of ['.lathe', '.vscode']) {
    const file = join(root, dir, 'launch.json');
    const opened = await backend()
      .fs.readText(file)
      .catch(() => null);
    if (!opened) continue;
    let parsed: { configurations?: unknown };
    try {
      parsed = parseJsonc<{ configurations?: unknown }>(opened.text);
    } catch (err) {
      notify('warning', `${dir}/launch.json isn't valid JSON.`, { detail: errorMessage(err) });
      continue;
    }
    if (!Array.isArray(parsed?.configurations)) continue;
    for (const raw of parsed.configurations as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const config = raw as Record<string, unknown>;
      if (typeof config.type !== 'string' || typeof config.name !== 'string') continue;
      if (names.has(config.name)) continue;
      names.add(config.name);
      // Windows-only fields win, as in VS Code.
      const windows =
        config.windows && typeof config.windows === 'object'
          ? (config.windows as Record<string, unknown>)
          : {};
      found.push({
        config: {
          request: 'launch',
          ...config,
          ...windows,
          type: config.type,
          name: config.name,
        } as LaunchConfig,
        file,
      });
    }
  }
  return found;
}

/** Languages "Debug this file" handles. */
export function canDebug(languageId: string | null | undefined): boolean {
  return !!languageId && !!adapterForLanguage(languageId);
}

/** Builds a Cargo project for debugging and returns its program, or why it couldn't. */
async function cargoBuild(dir: string): Promise<string> {
  clearOutput('Run');
  appendOutput('Run', '> cargo build --message-format=json-render-diagnostics\n');
  const built = await backend().toolchains.capture({
    program: 'cargo',
    args: ['build', '--message-format=json-render-diagnostics'],
    cwd: dir,
    env: [],
    timeoutMs: 600_000,
  });
  let program = '';
  for (const line of built.output.split(/\r?\n/)) {
    if (!line.startsWith('{')) {
      if (line.trim()) appendOutput('Run', `${line}\n`);
      continue;
    }
    try {
      const message = JSON.parse(line) as {
        reason?: string;
        executable?: string | null;
        target?: { kind?: string[] };
      };
      if (
        message.reason === 'compiler-artifact' &&
        message.executable &&
        message.target?.kind?.includes('bin')
      ) {
        program = message.executable;
      }
    } catch {
      // Not one of cargo's messages.
    }
  }
  if (built.code !== 0) throw new Error('cargo build failed. The Output panel (Run) shows why.');
  if (!program) throw new Error("cargo build didn't produce a program to debug.");
  return program;
}

/**
 * The configuration for debugging a file on its own, after building it if needed. A string says
 * why it can't be debugged; an empty string means a build failed (that was already reported).
 */
export async function fileConfiguration(doc: TextDoc): Promise<LaunchConfig | string> {
  const file = doc.path!;
  const cwd = dirname(file);
  const name = `Debug ${doc.name}`;
  const custom = adapterForLanguage(doc.languageId);
  if (custom?.custom)
    return { type: custom.types[0]!, request: 'launch', name, program: file, cwd };
  switch (doc.languageId) {
    case 'python':
      return { type: 'debugpy', request: 'launch', name, program: file, cwd };
    case 'javascript':
    case 'typescript':
      return { type: 'pwa-node', request: 'launch', name, program: file, cwd };
    case 'c':
    case 'cpp':
    case 'rust': {
      const plan = await planFor(doc);
      if (typeof plan === 'string') return plan;
      const rust = doc.languageId === 'rust';
      if (plan.run.program === 'cargo') {
        try {
          const program = await cargoBuild(plan.run.cwd);
          return {
            type: 'lldb',
            request: 'launch',
            name: `Debug ${basename(plan.run.cwd)}`,
            program,
            cwd: plan.run.cwd,
            sourceLanguages: ['rust'],
          };
        } catch (err) {
          return errorMessage(err);
        }
      }
      if (!(await buildPlan(doc, plan))) return '';
      return {
        type: 'lldb',
        request: 'launch',
        name,
        program: plan.run.program,
        cwd,
        sourceLanguages: [rust ? 'rust' : 'cpp'],
      };
    }
    default:
      return `Lathe can't debug ${doc.language?.name ?? 'these'} files yet. Python, JavaScript, TypeScript, C, C++ and Rust work.`;
  }
}

function template(languageId: string | undefined): string {
  const config: Record<string, unknown> =
    languageId === 'javascript' || languageId === 'typescript'
      ? { name: 'Node: current file', type: 'node', request: 'launch', program: '${file}' }
      : languageId === 'c' || languageId === 'cpp' || languageId === 'rust'
        ? {
            name: 'Debug main.exe',
            type: 'lldb',
            request: 'launch',
            program: '${workspaceFolder}\\main.exe',
            args: [],
            preLaunchTask: 'build',
          }
        : {
            name: 'Python: current file',
            type: 'debugpy',
            request: 'launch',
            program: '${file}',
            console: 'integratedTerminal',
          };
  const body = JSON.stringify({ version: '0.2.0', configurations: [config] }, null, 2);
  return [
    '// Debug configurations, in the format of VS Code\'s launch.json. "type" picks the debugger:',
    '// debugpy (Python), node (JavaScript and TypeScript) or lldb (C, C++ and Rust). ${file},',
    '// ${workspaceFolder} and the other variables work as in tasks.json, and "preLaunchTask" runs',
    '// a task first.',
    body,
    '',
  ].join('\n');
}

/** Opens the folder's launch.json, creating .lathe/launch.json if there's none. */
export async function openLaunchJson() {
  const root = useWorkspace.getState().root;
  if (!root) {
    notify('info', 'Open a folder to add debug configurations to it.');
    return;
  }
  for (const dir of ['.lathe', '.vscode']) {
    const existing = join(root, dir, 'launch.json');
    if (await backend().fs.stat(existing)) {
      await openPath(existing);
      return;
    }
  }
  const path = join(root, '.lathe', 'launch.json');
  try {
    if (!(await backend().fs.stat(dirname(path)))) await backend().fs.createDir(dirname(path));
    const format = await backend().fs.newFileFormat(path);
    await backend().fs.writeText(path, template(activeTab().doc?.languageId), format, null, false);
    await openPath(path);
  } catch (err) {
    notify('error', "Couldn't create .lathe/launch.json.", { detail: errorMessage(err) });
  }
}
