// What a plugin can ask of Lathe (the `lathe` object in its Worker, docs/plugins.md). Files and
// terminals need the permissions the plugin declared, which you saw when you installed it, and
// files must be inside the open folder.

import type { EditorView } from '@codemirror/view';
import { getActiveDoc, getActiveView, onActiveEditorChange } from '../editor/active';
import { addEditorExtensions } from '../editor/setup';
import { backend } from '../lib/backend';
import { debounce } from '../lib/events';
import { isAbsolute, isUnder, join, resolve } from '../lib/paths';
import { executeCommand, getCommand, registerCommands } from '../services/commands';
import { notify } from '../services/notifications';
import { useSettings } from '../services/settings';
import { quickInputText, quickPick } from '../workbench/quickinput/store';
import { runInTerminal } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { EditorView as View } from '@codemirror/view';
import type { PluginHost } from './host';
import { forgetProviders, registerProvider, unregisterProvider } from './providers';
import { removeStatusItems, setStatusItem } from './store';

/** Commands a plugin registered at run time (not in its manifest): removed with it. */
const dynamicCommands = new Map<string, Map<string, () => void>>();
/** Plugins that want to hear about the active editor. */
const watchers = new Set<PluginHost>();

export interface EditorInfo {
  path: string | null;
  languageId: string;
  text: string;
  selection: { from: number; to: number };
  /** 1-based. */
  line: number;
}

export function activeEditorInfo(): EditorInfo | null {
  const view = getActiveView();
  const doc = getActiveDoc();
  if (!view || !doc) return null;
  const { from, to, head } = view.state.selection.main;
  return {
    path: doc.path,
    languageId: doc.languageId,
    text: view.state.doc.toString(),
    selection: { from, to },
    line: view.state.doc.lineAt(head).number,
  };
}

const tellWatchers = debounce(() => {
  if (!watchers.size) return;
  const info = activeEditorInfo();
  for (const host of watchers) host.event('editor.changed', info);
}, 250);

onActiveEditorChange(() => tellWatchers());
addEditorExtensions(
  View.updateListener.of((update) => {
    if (watchers.size && (update.docChanged || update.selectionSet)) tellWatchers();
  }),
);

function need(host: PluginHost, permission: string) {
  if (!host.plugin.manifest.permissions.includes(permission)) {
    throw new Error(`${host.name} doesn't have the "${permission}" permission.`);
  }
}

/** A path from a plugin, as a file inside the open folder. */
function inFolder(path: unknown): string {
  const root = useWorkspace.getState().root;
  if (!root) throw new Error('No folder is open.');
  if (typeof path !== 'string' || !path) throw new Error('A path is needed.');
  const full = isAbsolute(path) ? path : resolve(root, path);
  if (!isUnder(full, root)) throw new Error('Plugins can only use files in the open folder.');
  return full;
}

/** What can cross back to the Worker (no functions, no cycles). */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

function edit(view: EditorView | null, text: string, replace: boolean) {
  if (!view) throw new Error('No editor is active.');
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from: replace ? from : to, to, insert: text },
    selection: { anchor: (replace ? from : to) + text.length },
    userEvent: 'input',
  });
}

/** A command a plugin registered without declaring it: shown by its id. */
function registerDynamic(host: PluginHost, command: string) {
  if (getCommand(command)) return;
  const remove = registerCommands([
    {
      id: command,
      title: command,
      category: host.name,
      run: (...args: never[]) => void host.invoke(`command:${command}`, args),
    },
  ]);
  let mine = dynamicCommands.get(host.id);
  if (!mine) {
    mine = new Map();
    dynamicCommands.set(host.id, mine);
  }
  mine.set(command, remove);
}

/** Drops what a plugin set up while running (when it stops or restarts). */
export function forgetPlugin(host: PluginHost, options: { keepCommands: boolean }) {
  watchers.delete(host);
  forgetProviders(host);
  removeStatusItems(host.id);
  if (!options.keepCommands) {
    for (const remove of dynamicCommands.get(host.id)?.values() ?? []) remove();
    dynamicCommands.delete(host.id);
  }
}

export async function callApi(
  host: PluginHost,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const text = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  switch (method) {
    case 'commands.register':
      registerDynamic(host, text('command'));
      return null;
    case 'commands.unregister': {
      const remove = dynamicCommands.get(host.id)?.get(text('command'));
      remove?.();
      dynamicCommands.get(host.id)?.delete(text('command'));
      return null;
    }
    case 'commands.execute':
      return jsonSafe(
        await executeCommand(
          text('command'),
          ...(Array.isArray(params.args) ? (params.args as unknown[]) : []),
        ),
      );
    case 'window.notify': {
      const kind =
        params.kind === 'error' ? 'error' : params.kind === 'warning' ? 'warning' : 'info';
      const actions = Array.isArray(params.actions) ? params.actions.map(String) : [];
      return new Promise((answer) => {
        notify(kind, `${host.name}: ${text('message')}`, {
          actions: actions.map((label) => ({ label, run: () => answer(label) })),
        });
        setTimeout(() => answer(null), actions.length ? 30_000 : 0);
      });
    }
    case 'window.quickPick': {
      const items = (Array.isArray(params.items) ? params.items : []).map((item, i) => {
        const value = item as { label?: unknown; description?: unknown } | string;
        const label = typeof value === 'string' ? value : String(value?.label ?? '');
        return {
          id: String(i),
          label,
          description:
            typeof value === 'object' && typeof value?.description === 'string'
              ? value.description
              : undefined,
        };
      });
      const picked = await quickPick(items, { placeholder: text('placeholder') || host.name });
      return picked ? picked.label : null;
    }
    case 'window.inputBox':
      return (
        (await quickInputText({
          placeholder: text('placeholder'),
          value: text('value'),
          prompt: text('prompt') || undefined,
        })) ?? null
      );
    case 'statusBar.set':
      setStatusItem({
        key: `${host.id}:${text('id')}`,
        plugin: host.id,
        text: text('text'),
        tooltip: text('tooltip') || undefined,
        command: text('command') || undefined,
        alignment: params.alignment === 'left' ? 'left' : 'right',
        visible: params.visible === true,
      });
      return null;
    case 'statusBar.remove':
      removeStatusItems(host.id, `${host.id}:${text('id')}`);
      return null;
    case 'editor.active':
      return activeEditorInfo();
    case 'editor.watch':
      watchers.add(host);
      host.event('editor.changed', activeEditorInfo());
      return null;
    case 'editor.insert':
      edit(getActiveView(), text('text'), false);
      return null;
    case 'editor.replaceSelection':
      edit(getActiveView(), text('text'), true);
      return null;
    case 'workspace.root':
      return useWorkspace.getState().root;
    case 'workspace.readFile':
      need(host, 'workspace.read');
      return (await backend().fs.readText(inFolder(params.path))).text;
    case 'workspace.writeFile': {
      need(host, 'workspace.write');
      const path = inFolder(params.path);
      const exists = await backend().fs.stat(path);
      const format = exists
        ? (await backend().fs.readText(path)).format
        : await backend().fs.newFileFormat(path);
      await backend().fs.writeText(path, text('text'), format, null, true);
      return null;
    }
    case 'workspace.findFiles': {
      need(host, 'workspace.read');
      const root = useWorkspace.getState().root;
      if (!root) return [];
      const found = await backend().workspace.findFiles(
        text('query'),
        typeof params.limit === 'number' ? params.limit : 50,
      );
      return found.matches.map((m) => join(root, m.path));
    }
    case 'languages.register':
      registerProvider(host, {
        id: text('id'),
        kind: params.kind === 'hover' ? 'hover' : 'completion',
        language: text('language') || '*',
      });
      return null;
    case 'languages.unregister':
      unregisterProvider(host, text('id'));
      return null;
    case 'terminal.run': {
      need(host, 'terminal');
      const root = useWorkspace.getState().root;
      await runInTerminal({
        title: text('title') || host.name,
        program: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-Command', text('command')],
        cwd: params.cwd ? inFolder(params.cwd) : (root ?? backend().boot().dataDir),
        env: [],
        tag: `plugin:${host.id}`,
      });
      return null;
    }
    case 'settings.get': {
      const key = text('key');
      const { user, workspace } = useSettings.getState();
      const value = workspace[key] ?? user[key];
      if (value !== undefined) return jsonSafe(value);
      const declared = (host.plugin.manifest.contributes?.settings ?? {}) as Record<
        string,
        { default?: unknown }
      >;
      return jsonSafe(declared[key]?.default ?? null);
    }
    default:
      throw new Error(`Lathe has no "${method}" for plugins.`);
  }
}
