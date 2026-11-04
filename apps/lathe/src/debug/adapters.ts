// The debug adapters Lathe knows, by launch-configuration type: debugpy for Python, js-debug for
// JavaScript and TypeScript, and CodeLLDB for C, C++ and Rust. Each is a pinned download into
// Lathe's tools folder (checked by SHA-256), so nothing is installed into your Python or Node.
// More can be added in settings.json under "debug.adapters". docs/spikes/dap.md has the details
// behind each command line.

import { type LspLaunch, backend } from '../lib/backend';
import { join } from '../lib/paths';
import { getSetting } from '../services/settings';
import { useWorkspace } from '../workbench/workspaceStore';
import type { LaunchConfig } from './store';

export interface AdapterInstall {
  /** The folder under tools\ it unpacks into. */
  name: string;
  url: string;
  sha256: string;
  size: string;
}

/** How Lathe talks to an adapter. */
export type Transport =
  /** DAP on the adapter's stdin and stdout (debugpy, your own adapters). */
  | { kind: 'stdio'; launch: LspLaunch }
  /** The adapter runs a server; Lathe reads its port from a log line and connects (js-debug). */
  | { kind: 'server'; launch: LspLaunch; port: RegExp }
  /** Lathe listens; the adapter connects back to that port (CodeLLDB). */
  | { kind: 'connect'; launch: (port: number) => LspLaunch };

export interface AdapterDef {
  id: string;
  name: string;
  /** Launch-configuration types it debugs. */
  types: string[];
  /** Lathe language ids it debugs with "Debug this file". */
  languages: string[];
  install?: AdapterInstall;
  /** The folder it's installed in, or null. */
  locate(tools: string): Promise<string | null>;
  /** Fills in what a configuration leaves out; a string says why it can't start. */
  resolve(config: LaunchConfig): Promise<LaunchConfig | string>;
  transport(dir: string, config: LaunchConfig): Promise<Transport | string>;
  /** Your own adapters run whatever they're told to. */
  custom?: boolean;
}

async function exists(path: string): Promise<boolean> {
  return !!(await backend()
    .fs.stat(path)
    .catch(() => null));
}

async function which(name: string): Promise<string | null> {
  return backend()
    .toolchains.which(name)
    .catch(() => null);
}

const realPython = new Map<string, Promise<string | null>>();

/** The interpreter itself: PyManager's python.exe is a launcher that starts the real one. */
function resolvePython(python: string): Promise<string | null> {
  let found = realPython.get(python);
  if (!found) {
    found = backend()
      .toolchains.capture({
        program: python,
        args: ['-I', '-c', 'import sys; print(sys.executable)'],
        cwd: backend().boot().dataDir || 'C:\\',
        env: [],
        timeoutMs: 20_000,
      })
      .then((r) => {
        const path = r.output.trim().split(/\r?\n/).at(-1)?.trim();
        return r.code === 0 && path ? path : null;
      })
      .catch(() => null);
    realPython.set(python, found);
  }
  return found;
}

/** The folder's .venv first, then python on PATH. */
async function defaultPython(): Promise<string | null> {
  const root = useWorkspace.getState().root;
  for (const dir of root ? ['.venv', 'venv', 'env'] : []) {
    const candidate = join(root!, dir, 'Scripts', 'python.exe');
    if (await exists(candidate)) return candidate;
  }
  const python = (await which('python')) ?? (await which('py'));
  return python ? resolvePython(python) : null;
}

const NO_PYTHON = "Python isn't installed. Install it from Run and debug → Toolchains.";
const NO_NODE = "Node.js isn't installed. Install it from Run and debug → Toolchains.";

const DEBUGPY_DIR = 'debugpy-1.8.22';

const DEBUGPY: AdapterDef = {
  id: 'debugpy',
  name: 'debugpy',
  types: ['debugpy', 'python'],
  languages: ['python'],
  install: {
    name: DEBUGPY_DIR,
    url: 'https://files.pythonhosted.org/packages/56/3d/c7dc9f35bc9e22cdb53679f844bee40fd5cff871862f60595869a433400d/debugpy-1.8.22-py2.py3-none-any.whl',
    sha256: 'a9e9d3550e15ca479c59333e90845029190531f0cacfedab3b815a57bd913947',
    size: '5 MB',
  },
  locate: async (tools) => {
    const dir = join(tools, DEBUGPY_DIR);
    return (await exists(join(dir, 'debugpy', 'adapter', '__main__.py'))) ? dir : null;
  },
  resolve: async (config) => {
    const python =
      typeof config.python === 'string' && config.python
        ? config.python
        : typeof config.pythonPath === 'string' && config.pythonPath
          ? config.pythonPath
          : await defaultPython();
    if (!python) return NO_PYTHON;
    return {
      console: 'integratedTerminal',
      justMyCode: true,
      showReturnValue: true,
      ...config,
      type: 'debugpy',
      python,
    };
  },
  transport: async (dir, config) => ({
    kind: 'stdio',
    // The adapter runs isolated (-I), with the same interpreter as the program.
    launch: {
      program: config.python as string,
      args: ['-I', join(dir, 'debugpy', 'adapter')],
      cwd: dir,
      env: [],
    },
  }),
};

const JS_DEBUG_DIR = 'js-debug-1.140.0';
const JS_TYPES: Record<string, string> = {
  node: 'pwa-node',
  chrome: 'pwa-chrome',
  msedge: 'pwa-msedge',
};

const JS_DEBUG: AdapterDef = {
  id: 'js-debug',
  name: 'JavaScript debugger',
  types: ['pwa-node', 'node', 'pwa-chrome', 'chrome', 'pwa-msedge', 'msedge'],
  languages: ['javascript', 'typescript'],
  install: {
    name: JS_DEBUG_DIR,
    url: 'https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz',
    sha256: '27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968',
    size: '1.3 MB',
  },
  locate: async (tools) => {
    const dir = join(tools, JS_DEBUG_DIR);
    return (await exists(join(dir, 'js-debug', 'src', 'dapDebugServer.js'))) ? dir : null;
  },
  resolve: async (config) => {
    const type = JS_TYPES[config.type] ?? config.type;
    if (type !== 'pwa-node') return { ...config, type };
    const node =
      typeof config.runtimeExecutable === 'string' && config.runtimeExecutable
        ? config.runtimeExecutable
        : await which('node');
    if (!node) return NO_NODE;
    return {
      console: 'internalConsole',
      skipFiles: ['<node_internals>/**'],
      ...config,
      type,
      runtimeExecutable: node,
    };
  },
  transport: async (dir) => {
    const node = await which('node');
    if (!node) return NO_NODE;
    return {
      kind: 'server',
      launch: {
        program: node,
        args: [join(dir, 'js-debug', 'src', 'dapDebugServer.js'), '0', '127.0.0.1'],
        cwd: dir,
        env: [],
      },
      port: /listening at [\d.]+:(\d+)/,
    };
  },
};

const CODELLDB_DIR = 'codelldb-1.12.3';

/** The Microsoft C++ extension's fields, for .vscode/launch.json files written for it. */
function fromCppTools(config: LaunchConfig): LaunchConfig {
  const env: Record<string, string> = {};
  if (Array.isArray(config.environment)) {
    for (const item of config.environment as { name?: unknown; value?: unknown }[]) {
      if (typeof item?.name === 'string') env[item.name] = String(item.value ?? '');
    }
  }
  const out: LaunchConfig = {
    type: 'lldb',
    request: config.request,
    name: config.name,
    program: config.program,
    args: config.args ?? [],
    cwd: config.cwd,
    env,
  };
  if (config.stopAtEntry === true) out.stopOnEntry = true;
  for (const key of ['preLaunchTask', 'postDebugTask'] as const) {
    if (config[key]) out[key] = config[key];
  }
  return out;
}

const CODELLDB: AdapterDef = {
  id: 'codelldb',
  name: 'CodeLLDB',
  types: ['lldb', 'cppdbg', 'cppvsdbg'],
  languages: ['c', 'cpp', 'rust'],
  install: {
    name: CODELLDB_DIR,
    url: 'https://github.com/vadimcn/codelldb/releases/download/v1.12.3/codelldb-win32-x64.vsix',
    sha256: 'a916e509308dac817732f63ca604a8b93ed29cd16f38a2fa9f0b64ed58e8f51a',
    size: '51 MB',
  },
  locate: async (tools) => {
    const dir = join(tools, CODELLDB_DIR);
    return (await exists(join(dir, 'extension', 'adapter', 'codelldb.exe'))) ? dir : null;
  },
  resolve: async (config) => {
    const base = config.type === 'lldb' ? config : fromCppTools(config);
    // Its own console window would need a terminal Lathe doesn't have: use Lathe's.
    const terminal = base.terminal === 'console' ? 'console' : 'integrated';
    return { sourceLanguages: ['cpp'], ...base, type: 'lldb', terminal };
  },
  transport: async (dir, config) => ({
    kind: 'connect',
    launch: (port) => ({
      program: join(dir, 'extension', 'adapter', 'codelldb.exe'),
      args: [
        '--connect',
        String(port),
        '--settings',
        JSON.stringify({ sourceLanguages: config.sourceLanguages ?? ['cpp'] }),
      ],
      cwd: dir,
      env: [],
    }),
  }),
};

const BUILTIN: AdapterDef[] = [DEBUGPY, JS_DEBUG, CODELLDB];

/** "debug.adapters": { "type": { "command": [program, ...args], "languages": [...] } }. */
interface CustomAdapter {
  command?: unknown;
  languages?: unknown;
  name?: unknown;
}

function customAdapters(): AdapterDef[] {
  const defs: AdapterDef[] = [];
  for (const [type, value] of Object.entries(getSetting('debug.adapters'))) {
    const adapter = (value ?? {}) as CustomAdapter;
    const command = Array.isArray(adapter.command)
      ? adapter.command.filter((c): c is string => typeof c === 'string')
      : [];
    const [program, ...args] = command;
    if (!program) continue;
    const languages = Array.isArray(adapter.languages)
      ? adapter.languages.filter((l): l is string => typeof l === 'string')
      : [];
    defs.push({
      id: type,
      name: typeof adapter.name === 'string' ? adapter.name : type,
      types: [type],
      languages,
      locate: async () => 'custom',
      resolve: async (config) => config,
      transport: async () => ({
        kind: 'stdio',
        launch: { program, args, cwd: useWorkspace.getState().root ?? 'C:\\', env: [] },
      }),
      custom: true,
    });
  }
  return defs;
}

/** The adapter for a launch-configuration type: your own first, then the built-in ones. */
export function adapterFor(type: string): AdapterDef | null {
  return [...customAdapters(), ...BUILTIN].find((a) => a.types.includes(type)) ?? null;
}

/** The adapter "Debug this file" uses for a language. */
export function adapterForLanguage(languageId: string): AdapterDef | null {
  return [...customAdapters(), ...BUILTIN].find((a) => a.languages.includes(languageId)) ?? null;
}

export function builtinAdapters(): AdapterDef[] {
  return BUILTIN;
}
