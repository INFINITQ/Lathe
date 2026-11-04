// Plugins at run time: loading the installed ones at start-up, applying what they declare
// (commands, keys, themes, snippets, language servers), starting their code when its activation
// events say so, and installing (after you've seen what a plugin asks for), turning on and off,
// and removing them.

import { onActiveEditorChange, getActiveDoc } from '../editor/active';
import { type InstalledPlugin, type PluginManifest, backend, errorMessage } from '../lib/backend';
import { parseJsonc } from '../lib/jsonc';
import type { ServerDef } from '../lsp/servers';
import { setPluginServers } from '../lsp/servers';
import { registerCommands } from '../services/commands';
import { ask } from '../services/dialogs';
import { type Keybinding, setPluginKeybindings } from '../services/keybindings';
import { notify } from '../services/notifications';
import { getSetting, useSettings } from '../services/settings';
import { quickInputText } from '../workbench/quickinput/store';
import { PluginHost, hostOf, listenToPlugins } from './host';
import { removeSnippets, setSnippets } from './providers';
import { PERMISSION_TEXT, usePlugins } from './store';
import { addThemes, applyColorTheme, removeThemes } from './themes';

interface Applied {
  plugin: InstalledPlugin;
  undo: (() => void)[];
  keybindings: Keybinding[];
  servers: ServerDef[];
}

const applied = new Map<string, Applied>();

function contributes(manifest: PluginManifest): Record<string, unknown> {
  const value = manifest.contributes;
  return value && typeof value === 'object' ? value : {};
}

function list<T = Record<string, unknown>>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function syncLayers() {
  setPluginKeybindings([...applied.values()].flatMap((a) => a.keybindings));
  setPluginServers([...applied.values()].flatMap((a) => a.servers));
}

/** Starts a plugin's code (if it has any) and waits for its activate(). */
async function activate(plugin: InstalledPlugin): Promise<PluginHost | null> {
  if (!plugin.manifest.main) return null;
  const host = hostOf(plugin.manifest.id) ?? new PluginHost(plugin);
  await host.start();
  return host;
}

/** Runs a command a plugin declared: its code starts first if it hasn't yet. */
async function runCommand(plugin: InstalledPlugin, command: string, args: unknown[]) {
  try {
    const host = await activate(plugin);
    if (!host) return;
    return await host.invoke(`command:${command}`, args);
  } catch (err) {
    notify('error', `${plugin.manifest.name}: "${command}" failed.`, {
      detail: errorMessage(err),
      actions: [{ label: 'Show log', run: () => hostOf(plugin.manifest.id)?.showLog() }],
    });
  }
}

function apply(plugin: InstalledPlugin) {
  const { manifest } = plugin;
  const declared = contributes(manifest);
  const entry: Applied = { plugin, undo: [], keybindings: [], servers: [] };
  applied.set(manifest.id, entry);

  const commands = list<{ command?: unknown; title?: unknown; category?: unknown }>(
    declared.commands,
  ).filter((c) => typeof c.command === 'string');
  if (commands.length) {
    entry.undo.push(
      registerCommands(
        commands.map((c) => ({
          id: c.command as string,
          title: typeof c.title === 'string' ? c.title : (c.command as string),
          category: typeof c.category === 'string' ? c.category : manifest.name,
          run: (...args: never[]) => runCommand(plugin, c.command as string, args),
        })),
      ),
    );
  }

  entry.keybindings = list<{ key?: unknown; command?: unknown; when?: unknown }>(
    declared.keybindings,
  )
    .filter((k) => typeof k.key === 'string' && typeof k.command === 'string')
    .map((k) => ({
      key: k.key as string,
      command: k.command as string,
      ...(typeof k.when === 'string' ? { when: k.when } : {}),
    }));

  if (declared.themes) {
    addThemes(manifest.id, declared.themes);
    entry.undo.push(() => removeThemes(manifest.id));
  }

  for (const snippet of list<{ language?: unknown; path?: unknown }>(declared.snippets)) {
    if (typeof snippet.path !== 'string') continue;
    const language = typeof snippet.language === 'string' ? snippet.language : '*';
    void backend()
      .plugins.readText(manifest.id, snippet.path)
      .then((text) => setSnippets(manifest.id, language, parseJsonc(text)))
      .catch((err: unknown) =>
        notify('warning', `${manifest.name}'s snippets didn't load.`, {
          detail: errorMessage(err),
        }),
      );
  }
  entry.undo.push(() => removeSnippets(manifest.id));

  const servers = declared.languageServers;
  if (servers && typeof servers === 'object') {
    for (const [id, value] of Object.entries(servers as Record<string, unknown>)) {
      const server = value as { command?: unknown; languages?: unknown; name?: unknown };
      const command = list<string>(server.command).filter((c) => typeof c === 'string');
      const languages = list<string>(server.languages).filter((l) => typeof l === 'string');
      const [program, ...args] = command;
      if (!program || !languages.length) continue;
      entry.servers.push({
        id: `${manifest.id}.${id}`,
        name: typeof server.name === 'string' ? server.name : id,
        languages,
        find: async () => ({ program, args }),
        needsTrust: true,
      });
    }
  }
  syncLayers();

  // Start now, or wait for a command or a language.
  const events = manifest.activationEvents;
  if (manifest.main && (!events.length || events.includes('onStartup') || events.includes('*'))) {
    void activate(plugin).catch(() => {});
  }
}

function unapply(id: string) {
  const entry = applied.get(id);
  if (!entry) return;
  applied.delete(id);
  entry.undo.forEach((undo) => undo());
  hostOf(id)?.stop();
  syncLayers();
}

/** onLanguage:<id> plugins start when an editor of that language becomes active. */
function startForLanguage() {
  const language = getActiveDoc()?.languageId;
  if (!language) return;
  for (const { plugin } of applied.values()) {
    if (plugin.manifest.activationEvents.includes(`onLanguage:${language}`)) {
      void activate(plugin).catch(() => {});
    }
  }
}

/** Reads the installed plugins and starts the ones that are on (at start-up, and after changes). */
export async function loadPlugins() {
  listenToPlugins();
  let installed: InstalledPlugin[];
  try {
    installed = await backend().plugins.list();
  } catch (err) {
    notify('error', "Couldn't read the installed plugins.", { detail: errorMessage(err) });
    return;
  }
  usePlugins.setState({ installed });
  const wanted = new Set(installed.filter((p) => p.enabled).map((p) => p.manifest.id));
  for (const id of [...applied.keys()]) {
    const now = installed.find((p) => p.manifest.id === id);
    // Gone, off, or a new version: take the old one down.
    if (!wanted.has(id) || now?.manifest.version !== applied.get(id)?.plugin.manifest.version) {
      unapply(id);
    }
  }
  for (const plugin of installed) {
    if (plugin.enabled && !applied.has(plugin.manifest.id)) apply(plugin);
  }
  startForLanguage();
  await applyColorTheme();
}

let watching = false;

/** Start-up: plugins, and the hooks that start plugins later. */
export function installPlugins(): () => void {
  void loadPlugins();
  if (watching) return () => {};
  watching = true;
  const stops = [
    onActiveEditorChange(() => startForLanguage()),
    useSettings.subscribe((s, prev) => {
      if (s.user['workbench.colorTheme'] !== prev.user['workbench.colorTheme']) {
        void applyColorTheme();
      }
    }),
  ];
  return () => {
    watching = false;
    stops.forEach((stop) => stop());
  };
}

function describe(manifest: PluginManifest): string {
  const asks = manifest.permissions.map((p) => `• ${PERMISSION_TEXT[p] ?? p}`);
  const parts = [
    manifest.description,
    manifest.publisher ? `By ${manifest.publisher}.` : '',
    asks.length
      ? `It asks to:\n${asks.join('\n')}`
      : manifest.main
        ? 'It runs its code in its own sandbox, with no access to your files.'
        : "It only adds themes, snippets or settings; it doesn't run code.",
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Installs a plugin from a folder, a .zip or a Git URL, after asking. */
export async function installPlugin(kind: 'folder' | 'zip' | 'git') {
  const source =
    kind === 'folder'
      ? await backend().dialogs.pickFolder()
      : kind === 'zip'
        ? ((await backend().dialogs.pickFiles())[0] ?? null)
        : await quickInputText({
            placeholder: 'https://github.com/someone/lathe-plugin',
            prompt: "The plugin's Git URL (https). Press Enter to fetch it.",
          });
  if (!source) return;
  let staged;
  try {
    staged = await backend().plugins.stage(kind, source);
  } catch (err) {
    notify('error', "That plugin can't be installed.", { detail: errorMessage(err) });
    return;
  }
  const { manifest } = staged;
  const answer = await ask({
    title: staged.replaces
      ? `Update ${manifest.name} from ${staged.replaces} to ${manifest.version}?`
      : `Install ${manifest.name} ${manifest.version}?`,
    message: describe(manifest),
    buttons: [
      { id: 'install', label: staged.replaces ? 'Update' : 'Install', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'install') {
    await backend().plugins.discard(staged.stagingId);
    return;
  }
  try {
    unapply(manifest.id);
    await backend().plugins.install(staged.stagingId);
  } catch (err) {
    notify('error', `Couldn't install ${manifest.name}.`, { detail: errorMessage(err) });
    return;
  }
  await loadPlugins();
  notify('info', `${manifest.name} is installed.`);
}

export async function setPluginEnabled(id: string, enabled: boolean) {
  // The switch moves at once; the plugin follows once that's saved.
  usePlugins.setState((s) => ({
    installed: s.installed.map((p) => (p.manifest.id === id ? { ...p, enabled } : p)),
  }));
  try {
    await backend().plugins.setEnabled(id, enabled);
  } catch (err) {
    notify('error', "Couldn't change the plugin.", { detail: errorMessage(err) });
  }
  await loadPlugins();
}

export async function uninstallPlugin(id: string) {
  const plugin = usePlugins.getState().installed.find((p) => p.manifest.id === id);
  const answer = await ask({
    title: `Remove ${plugin?.manifest.name ?? id}?`,
    message: 'Lathe deletes its folder. Its settings stay in settings.json.',
    buttons: [
      { id: 'remove', label: 'Remove', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'remove') return;
  unapply(id);
  if (getSetting('workbench.colorTheme').startsWith(`${id}:`)) {
    await backend().settings.set('user', { 'workbench.colorTheme': null });
  }
  await backend().plugins.uninstall(id);
  await loadPlugins();
}

export function restartPlugin(id: string) {
  const host = hostOf(id);
  if (host) host.restart();
  else {
    const plugin = usePlugins.getState().installed.find((p) => p.manifest.id === id);
    if (plugin) void activate(plugin).catch(() => {});
  }
}
