// Which language server serves which document. A server starts the first time you open one of
// its files (Lathe offers to install it first, once), serves every file of its languages in the
// same folder, and attaches to their editors. Saves and changes on disk are passed on to it.

import { LSPPlugin } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import type * as lsp from 'vscode-languageserver-protocol';
import { getActiveDoc } from '../editor/active';
import { type TextDoc, allDocuments, onDocumentSaved } from '../editor/documents';
import { compartments, setLspExtensionProvider } from '../editor/setup';
import type { SymbolKind } from '../editor/symbols';
import { type FsChange, backend, errorMessage } from '../lib/backend';
import { dirname, isUnder, join, pathKey } from '../lib/paths';
import { dismiss, notify } from '../services/notifications';
import { getSetting, updateSetting } from '../services/settings';
import { type WorkspaceSymbol, registerSymbolProvider } from '../services/workspaceSymbols';
import { ensureTrusted } from '../run/run';
import { showView } from '../workbench/layout';
import { quickPick } from '../workbench/quickinput/store';
import { runInTerminal, terminalExited } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { latheLspFeatures } from './features';
import { LanguageServer, showOutput } from './server';
import { type Install, type ServerDef, allServers, serverFor } from './servers';
import { pathToUri, uriToPath } from './uri';

const servers = new Map<string, LanguageServer>();
const starting = new Map<string, Promise<void>>();
const offered = new Set<string>();

function rootFor(path: string): string {
  const root = useWorkspace.getState().root;
  return root && isUnder(path, root) ? root : dirname(path);
}

const keyOf = (def: ServerDef, root: string) => `${def.id}|${pathKey(root)}`;

function serverOf(doc: TextDoc): LanguageServer | null {
  if (!doc.path) return null;
  const def = serverFor(doc.languageId);
  return def ? (servers.get(keyOf(def, rootFor(doc.path))) ?? null) : null;
}

/** The LSP part of an editor for `doc`: nothing until its server exists. */
export function lspExtensionFor(doc: TextDoc): Extension {
  if (!doc.path) return [];
  const server = serverOf(doc);
  if (!server) {
    void ensureServer(doc);
    return [];
  }
  if (server.state === 'stopped' || server.state === 'failed') return [];
  return [server.client.plugin(pathToUri(doc.path), doc.languageId), latheLspFeatures];
}

setLspExtensionProvider(lspExtensionFor);

/** Puts the server into every open editor of its files. */
function attach(server: LanguageServer) {
  for (const doc of allDocuments()) {
    if (!doc.path || serverOf(doc) !== server) continue;
    for (const view of doc.views) {
      if (LSPPlugin.get(view)?.client === server.client) continue;
      view.dispatch({ effects: compartments.lsp.reconfigure(lspExtensionFor(doc)) });
    }
  }
}

function detach(server: LanguageServer) {
  for (const doc of allDocuments()) {
    for (const view of doc.views) {
      if (LSPPlugin.get(view)?.client === server.client) {
        view.dispatch({ effects: compartments.lsp.reconfigure([]) });
      }
    }
  }
}

async function ensureServer(doc: TextDoc): Promise<void> {
  const def = serverFor(doc.languageId);
  if (!def || !doc.path) return;
  const root = rootFor(doc.path);
  const key = keyOf(def, root);
  if (servers.has(key) || starting.has(key)) return starting.get(key);
  const run = (async () => {
    const tools = await backend().lsp.toolsDir();
    const launch = await def.find(tools);
    if (!launch) {
      offerInstall(def, doc);
      return;
    }
    if (def.needsTrust && !(await ensureTrusted(root))) return;
    const server = new LanguageServer(def, root, key, launch);
    servers.set(key, server);
    attach(server);
    try {
      await server.start();
    } catch (err) {
      notify('error', `${def.name} didn't start.`, {
        detail: errorMessage(err),
        actions: [
          ...(def.install
            ? [{ label: `Install ${def.name}`, run: () => void installServer(def) }]
            : []),
          { label: 'Show output', run: () => showOutput(server.outputChannel) },
        ],
      });
    }
  })().finally(() => starting.delete(key));
  starting.set(key, run);
  return run;
}

function describeInstall(install: Install): string {
  if (install.kind === 'npm') {
    return `Lathe runs npm install ${install.package}@${install.version} (about ${install.size}) into its own tools folder.`;
  }
  if (install.kind === 'archive') {
    return `Lathe downloads ${install.url.split('/').pop()} (about ${install.size}), checks its SHA-256 and unpacks it into its tools folder.`;
  }
  return `Lathe runs: ${install.program} ${install.args.join(' ')}`;
}

function offerInstall(def: ServerDef, doc: TextDoc) {
  if (!def.install || offered.has(def.id) || getSetting('lsp.declined').includes(def.id)) return;
  offered.add(def.id);
  notify(
    'info',
    `Install ${def.name} for ${doc.language?.name ?? doc.languageId} code intelligence?`,
    {
      detail: describeInstall(def.install),
      actions: [
        { label: 'Install', run: () => void installServer(def) },
        {
          label: "Don't ask again",
          run: () => void updateSetting('lsp.declined', [...getSetting('lsp.declined'), def.id]),
        },
      ],
    },
  );
}

/** Installs a server, then starts it for the files already open. */
export async function installServer(def: ServerDef): Promise<void> {
  const install = def.install;
  if (!install) return;
  const tools = await backend().lsp.toolsDir();
  try {
    if (!(await backend().fs.stat(tools))) await backend().fs.createDir(tools);
    if (install.kind === 'npm') {
      const node = await backend().toolchains.which('node');
      if (!node) {
        notify('warning', `${def.name} needs Node.js, which isn't installed.`, {
          actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
        });
        return;
      }
      const npm = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const info = await runInTerminal({
        title: `Install ${def.name}`,
        program: node,
        args: [
          npm,
          'install',
          '--prefix',
          join(tools, install.dir),
          '--no-audit',
          '--no-fund',
          '--save-exact',
          `${install.package}@${install.version}`,
        ],
        cwd: tools,
        env: [],
        tag: `install:${def.id}`,
      });
      if (!info || (await terminalExited(info.id)).code !== 0) {
        notify('error', `Installing ${def.name} didn't finish.`, {
          detail: "npm's output is in the terminal.",
        });
        return;
      }
    } else if (install.kind === 'archive') {
      const toast = notify('info', `Downloading ${def.name} (about ${install.size})…`, {
        timeout: 0,
      });
      try {
        await backend().lsp.installArchive(install.name, install.url, install.sha256);
      } finally {
        dismiss(toast);
      }
    } else {
      const program = await backend().toolchains.which(install.needs);
      if (!program) {
        notify(
          'warning',
          `${def.name} is installed with ${install.needs}, which isn't installed.`,
          {
            actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
          },
        );
        return;
      }
      const info = await runInTerminal({
        title: `Install ${def.name}`,
        program,
        args: install.args,
        cwd: tools,
        env: [],
        tag: `install:${def.id}`,
      });
      if (!info || (await terminalExited(info.id)).code !== 0) {
        notify('error', `Installing ${def.name} didn't finish.`, {
          detail: 'The terminal shows why.',
        });
        return;
      }
    }
    notify('info', `${def.name} is installed.`);
    offered.delete(def.id);
    for (const [key, server] of servers) {
      if (server.def.id === def.id && server.state === 'failed') servers.delete(key);
    }
    for (const doc of allDocuments()) {
      if (doc.path && def.languages.includes(doc.languageId)) void ensureServer(doc);
    }
  } catch (err) {
    notify('error', `Couldn't install ${def.name}.`, { detail: errorMessage(err) });
  }
}

/** The server for the active editor's file, if any. */
export function activeServer(): LanguageServer | null {
  const doc = getActiveDoc();
  return doc ? serverOf(doc) : null;
}

export async function restartActiveServer() {
  const server = activeServer();
  if (!server) {
    const doc = getActiveDoc();
    if (doc) await ensureServer(doc);
    else notify('info', 'Open a file to restart its language server.');
    return;
  }
  attach(server);
  await server.restart().catch((err: unknown) => {
    notify('error', `${server.def.name} didn't restart.`, { detail: errorMessage(err) });
  });
}

export async function stopActiveServer() {
  const server = activeServer();
  if (!server) return;
  await server.stop();
  detach(server);
  servers.delete(server.key);
}

export function showActiveServerOutput() {
  const server = activeServer();
  if (server) showOutput(server.outputChannel);
  else notify('info', 'No language server is running for this file.');
}

/** Lets you pick a server to install. */
export async function pickServerToInstall() {
  const installable = allServers().filter((d) => d.install);
  const picked = await quickPick(
    installable.map((d, i) => ({
      id: String(i),
      label: d.name,
      description: d.languages.join(', '),
    })),
    { placeholder: 'Install a language server' },
  );
  if (picked) await installServer(installable[Number(picked.id)]!);
}

onDocumentSaved((doc) => {
  if (doc.path) serverOf(doc)?.didSave(doc.path);
});

/** Changes on disk, from the folder watcher. */
export function lspFilesChanged(changes: FsChange[]) {
  for (const server of servers.values()) server.filesChanged(changes);
}

/** Stops every server (closing the folder). */
export async function stopAllServers() {
  const all = [...servers.values()];
  servers.clear();
  await Promise.all(
    all.map(async (s) => {
      detach(s);
      await s.stop();
    }),
  );
}

const KINDS: Record<number, SymbolKind> = {
  2: 'module',
  3: 'namespace',
  4: 'module',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'property',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  20: 'key',
  22: 'constant',
  23: 'struct',
  26: 'type',
};

// "#" in quick open also asks running servers for workspace symbols.
registerSymbolProvider(async (query) => {
  const results = await Promise.all(
    [...servers.values()]
      .filter((s) => s.state === 'running' && s.client.serverCapabilities?.workspaceSymbolProvider)
      .map(async (server) => {
        const found = await Promise.race([
          server.client
            .request<
              lsp.WorkspaceSymbolParams,
              (lsp.SymbolInformation | lsp.WorkspaceSymbol)[] | null
            >('workspace/symbol', { query })
            .catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        return (found ?? []).flatMap((symbol): WorkspaceSymbol[] => {
          const location = symbol.location;
          const path = uriToPath(location.uri);
          if (!path) return [];
          const start = 'range' in location ? location.range.start : { line: 0, character: 0 };
          return [
            {
              name: symbol.name,
              kind: KINDS[symbol.kind] ?? 'variable',
              path,
              line: start.line + 1,
              column: start.character,
            },
          ];
        });
      }),
  );
  return results.flat();
});
