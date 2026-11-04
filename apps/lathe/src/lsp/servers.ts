// The language servers Lathe knows: which languages each one serves, where it's installed
// (Lathe's tools folder first, then PATH), and how to install it (npm into the tools folder, a
// pinned download, or a toolchain's own installer). More can be added in settings.json under
// "lsp.servers".

import { backend } from '../lib/backend';
import { dirname, join } from '../lib/paths';
import { getSetting } from '../services/settings';

export interface ServerLaunch {
  program: string;
  args: string[];
  env?: [string, string][];
}

export type Install =
  /** npm install into tools\\<dir>. */
  | { kind: 'npm'; dir: string; package: string; version: string; size: string }
  | { kind: 'archive'; name: string; url: string; sha256: string; size: string }
  | { kind: 'command'; program: string; args: string[]; needs: string };

export interface ServerDef {
  id: string;
  name: string;
  /** Lathe's language ids. */
  languages: string[];
  find(tools: string): Promise<ServerLaunch | null>;
  install?: Install;
  /** Answers to workspace/configuration, by section ("python.analysis"…). */
  settings?: Record<string, unknown>;
  initializationOptions?: unknown;
  /** It runs project code (build scripts, macros), so the folder must be trusted first. */
  needsTrust?: boolean;
}

async function exists(path: string): Promise<boolean> {
  return !!(await backend()
    .fs.stat(path)
    .catch(() => null));
}

async function onPath(name: string): Promise<string | null> {
  return backend()
    .toolchains.which(name)
    .catch(() => null);
}

/** A server installed with npm into tools\<id>, run with Node. */
function npmServer(
  id: string,
  pkg: string,
  script: string,
  args: string[],
  pathFallback?: string,
): (tools: string) => Promise<ServerLaunch | null> {
  return async (tools) => {
    const entry = join(tools, id, 'node_modules', ...pkg.split('/'), ...script.split('/'));
    if ((await exists(entry)) && (await onPath('node')))
      return { program: 'node', args: [entry, ...args] };
    const found = pathFallback ? await onPath(pathFallback) : null;
    return found ? { program: found, args } : null;
  };
}

const CLANGD_VERSION = '23.1.0';

export const BUILTIN_SERVERS: ServerDef[] = [
  {
    id: 'basedpyright',
    name: 'basedpyright',
    languages: ['python'],
    find: npmServer(
      'basedpyright',
      'basedpyright',
      'langserver.index.js',
      ['--stdio'],
      'basedpyright-langserver',
    ),
    install: {
      kind: 'npm',
      dir: 'basedpyright',
      package: 'basedpyright',
      version: '1.40.2',
      size: '20 MB',
    },
    settings: {
      'basedpyright.analysis': { typeCheckingMode: 'standard', autoImportCompletions: true },
      'python.analysis': { typeCheckingMode: 'standard' },
    },
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
    find: npmServer('typescript', 'typescript', 'bin/tsc', ['--lsp', '--stdio']),
    install: {
      kind: 'npm',
      dir: 'typescript',
      package: 'typescript',
      version: '7.0.2',
      size: '25 MB',
    },
  },
  {
    id: 'clangd',
    name: 'clangd',
    languages: ['c', 'cpp'],
    find: async (tools) => {
      const bundled = join(tools, 'clangd', `clangd_${CLANGD_VERSION}`, 'bin', 'clangd.exe');
      const program = (await exists(bundled)) ? bundled : await onPath('clangd');
      if (!program) return null;
      return { program, args: ['--background-index', '--header-insertion=never', '--log=error'] };
    },
    install: {
      kind: 'archive',
      name: 'clangd',
      url: `https://github.com/clangd/clangd/releases/download/${CLANGD_VERSION}/clangd-windows-${CLANGD_VERSION}.zip`,
      sha256: '23412a240756a162e7b98a282f36aa2a23a88db5ce16a0cbc4fef7253768c810',
      size: '30 MB',
    },
    // Loose files (no compile_commands.json) get a modern standard.
    initializationOptions: { fallbackFlags: ['-std=c++20'] },
  },
  {
    id: 'rust-analyzer',
    name: 'rust-analyzer',
    languages: ['rust'],
    find: async () => {
      const program = await onPath('rust-analyzer');
      if (!program) return null;
      // rustup puts a proxy on PATH even when the component isn't installed.
      const check = await backend()
        .toolchains.capture({
          program,
          args: ['--version'],
          cwd: dirname(program),
          env: [],
          timeoutMs: 10_000,
        })
        .catch(() => null);
      return check?.code === 0 ? { program, args: [] } : null;
    },
    install: {
      kind: 'command',
      program: 'rustup',
      args: ['component', 'add', 'rust-analyzer'],
      needs: 'rustup',
    },
    needsTrust: true,
  },
  {
    id: 'json',
    name: 'JSON language server',
    languages: ['json'],
    find: npmServer(
      'vscode-langservers',
      'vscode-langservers-extracted',
      'bin/vscode-json-language-server',
      ['--stdio'],
    ),
    install: {
      kind: 'npm',
      dir: 'vscode-langservers',
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      size: '15 MB',
    },
    initializationOptions: { provideFormatter: true },
    settings: { json: { validate: { enable: true }, format: { enable: true } } },
  },
  {
    id: 'css',
    name: 'CSS language server',
    languages: ['css', 'scss', 'less'],
    find: npmServer(
      'vscode-langservers',
      'vscode-langservers-extracted',
      'bin/vscode-css-language-server',
      ['--stdio'],
    ),
    install: {
      kind: 'npm',
      dir: 'vscode-langservers',
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      size: '15 MB',
    },
    initializationOptions: { provideFormatter: true },
    settings: { css: { validate: true }, scss: { validate: true }, less: { validate: true } },
  },
  {
    id: 'html',
    name: 'HTML language server',
    languages: ['html'],
    find: npmServer(
      'vscode-langservers',
      'vscode-langservers-extracted',
      'bin/vscode-html-language-server',
      ['--stdio'],
    ),
    install: {
      kind: 'npm',
      dir: 'vscode-langservers',
      package: 'vscode-langservers-extracted',
      version: '4.10.0',
      size: '15 MB',
    },
    initializationOptions: {
      provideFormatter: true,
      embeddedLanguages: { css: true, javascript: true },
    },
  },
  {
    id: 'yaml',
    name: 'YAML language server',
    languages: ['yaml'],
    find: npmServer('yaml', 'yaml-language-server', 'bin/yaml-language-server', ['--stdio']),
    install: {
      kind: 'npm',
      dir: 'yaml',
      package: 'yaml-language-server',
      version: '2.0.0',
      size: '10 MB',
    },
    settings: { yaml: { validate: true, format: { enable: true } } },
  },
  {
    id: 'gopls',
    name: 'gopls',
    languages: ['go'],
    find: async () => {
      const program = await onPath('gopls');
      return program ? { program, args: [] } : null;
    },
    install: {
      kind: 'command',
      program: 'go',
      args: ['install', 'golang.org/x/tools/gopls@latest'],
      needs: 'go',
    },
    needsTrust: true,
  },
  {
    id: 'jdtls',
    name: 'Eclipse JDT (Java)',
    languages: ['java'],
    find: async () => {
      const program = await onPath('jdtls');
      return program ? { program, args: [] } : null;
    },
    needsTrust: true,
  },
];

/** A server from settings: "lsp.servers": { "id": { "command": [...], "languages": [...] } }. */
interface CustomServer {
  command?: unknown;
  languages?: unknown;
  initializationOptions?: unknown;
  settings?: unknown;
  name?: unknown;
}

function customServers(): ServerDef[] {
  const raw = getSetting('lsp.servers');
  const defs: ServerDef[] = [];
  for (const [id, value] of Object.entries(raw)) {
    const server = value as CustomServer;
    const command = Array.isArray(server.command)
      ? server.command.filter((c): c is string => typeof c === 'string')
      : [];
    const languages = Array.isArray(server.languages)
      ? server.languages.filter((l): l is string => typeof l === 'string')
      : [];
    const [program, ...args] = command;
    if (!program || !languages.length) continue;
    defs.push({
      id,
      name: typeof server.name === 'string' ? server.name : id,
      languages,
      find: async () => ({ program, args }),
      initializationOptions: server.initializationOptions,
      settings:
        server.settings && typeof server.settings === 'object'
          ? (server.settings as Record<string, unknown>)
          : undefined,
      needsTrust: true,
    });
  }
  return defs;
}

/** Servers plugins declare ("languageServers" in lathe-plugin.json). */
let fromPlugins: ServerDef[] = [];
export function setPluginServers(defs: ServerDef[]) {
  fromPlugins = defs;
}

/** The server for a language: your own servers first, then the built-in ones. */
export function serverFor(languageId: string): ServerDef | null {
  if (!getSetting('lsp.enabled')) return null;
  const disabled = new Set(getSetting('lsp.disabled'));
  const all = [...customServers(), ...fromPlugins, ...BUILTIN_SERVERS];
  return all.find((def) => def.languages.includes(languageId) && !disabled.has(def.id)) ?? null;
}

export function allServers(): ServerDef[] {
  return [...customServers(), ...fromPlugins, ...BUILTIN_SERVERS];
}
