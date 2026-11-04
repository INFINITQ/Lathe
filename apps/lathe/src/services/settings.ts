// Settings: built-in defaults, then yours (settings.json), then the folder's
// (.lathe/settings.json). Language sections such as "[python]": { "editor.tabSize": 4 } apply
// on top for files of that language, as in VS Code.

import { create } from 'zustand';
import { type AllSettings, type SettingsScope, backend, errorMessage } from '../lib/backend';

export const DEFAULT_SETTINGS = {
  'workbench.theme': 'system' as 'system' | 'dark' | 'light',
  'workbench.accent': 'lime' as Accent,
  /** A plugin's colour theme ("<plugin id>:<label>"), or "" for Mono. */
  'workbench.colorTheme': '',
  'workbench.activityBar.visible': true,
  'workbench.statusBar.visible': true,
  'workbench.editor.showTabs': true,
  'workbench.editor.enablePreview': true,
  'workbench.startupEditor': 'welcome' as 'welcome' | 'none',
  'window.restoreFolder': true,
  'editor.fontFamily': '',
  'editor.fontSize': 13,
  'editor.lineHeight': 1.65,
  'editor.fontLigatures': false,
  'editor.tabSize': 4,
  'editor.insertSpaces': true,
  'editor.detectIndentation': true,
  'editor.wordWrap': 'off' as 'off' | 'on',
  'editor.lineNumbers': 'on' as 'on' | 'off' | 'relative',
  'editor.minimap.enabled': true,
  'editor.renderWhitespace': 'none' as 'none' | 'trailing' | 'all',
  'editor.renderLineHighlight': true,
  'editor.cursorBlinking': true,
  'editor.guides.indentation': true,
  'editor.matchBrackets': true,
  'editor.autoClosingBrackets': true,
  'editor.folding': true,
  'editor.scrollBeyondLastLine': true,
  'editor.formatOnSave': false,
  'editor.emmet': true,
  /** Lighter editing for big files (see editor/setup.ts). */
  'editor.largeFileOptimizations': true,
  /** Vim's modes and keys in the editor. */
  'editor.vim': false,
  'files.autoSave': 'off' as 'off' | 'afterDelay' | 'onFocusChange',
  'files.autoSaveDelay': 1000,
  'files.trimTrailingWhitespace': false,
  'files.insertFinalNewline': false,
  'files.hotExit': true,
  'files.exclude': {
    '**/.git': true,
    '**/.svn': true,
    '**/.hg': true,
    '**/Thumbs.db': true,
  } as Record<string, boolean>,
  'explorer.confirmDelete': true,
  'explorer.confirmDragAndDrop': true,
  'explorer.autoReveal': true,
  'search.exclude': {
    '**/node_modules': true,
    '**/bower_components': true,
    '**/*.code-search': true,
  } as Record<string, boolean>,
  'search.useIgnoreFiles': true,
  'search.searchOnType': true,
  'search.searchOnTypeDebouncePeriod': 300,
  'search.maxResults': 20000,
  'editor.stickyScroll.enabled': true,
  'breadcrumbs.symbolPath': true,
  'git.blame.inline': false,
  'lsp.enabled': true,
  /** "messages" logs every message to and from servers in their Output channel. */
  'lsp.trace': 'off' as 'off' | 'messages',
  /** Built-in servers you've turned off, by id ("basedpyright", "clangd"…). */
  'lsp.disabled': [] as string[],
  /** Your own servers: { id: { command: [program, ...args], languages: [...] } }. */
  'lsp.servers': {} as Record<string, unknown>,
  /** Servers Lathe has offered to install and you said no to. */
  'lsp.declined': [] as string[],
  'editor.inlayHints.enabled': true,
  'editor.formatOnSaveTimeout': 2000,
  /** Your own debug adapters: { type: { command: [program, ...args], languages: [...] } }. */
  'debug.adapters': {} as Record<string, unknown>,
  /** When the Debug console opens by itself (programs in a terminal never open it). */
  'debug.openDebugConsole': 'openOnFirstSessionStart' as
    'openOnSessionStart' | 'openOnFirstSessionStart' | 'neverOpen',
  /** Bring the editor (and the window) forward when a program stops at a breakpoint. */
  'debug.focusEditorOnBreak': true,
};

export type Accent = 'lime' | 'sky' | 'violet' | 'amber' | 'rose' | 'mint';
export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;
type Values = Record<string, unknown>;

interface SettingsState {
  user: Values;
  workspace: Values;
  userPath: string;
  workspacePath: string | null;
  /** Syntax errors in a settings file (its last good values stay in effect). */
  errors: string[];
}

export const useSettings = create<SettingsState>(() => {
  const boot = backend().boot().settings;
  return {
    user: boot.values,
    workspace: {},
    userPath: boot.path,
    workspacePath: null,
    errors: boot.error ? [boot.error] : [],
  };
});

function pick(values: Values, key: string, language?: string): unknown {
  if (language) {
    const section = values[`[${language}]`];
    if (section && typeof section === 'object' && key in section) {
      return (section as Values)[key];
    }
  }
  return values[key];
}

/** A setting's value for `language` (or in general), with the default as a fallback. */
export function getSetting<K extends SettingKey>(key: K, language?: string): Settings[K] {
  const { user, workspace } = useSettings.getState();
  for (const value of [pick(workspace, key, language), pick(user, key, language)]) {
    if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
      return value as Settings[K];
    }
  }
  return DEFAULT_SETTINGS[key];
}

/** React hook: a setting's current value; re-renders when it changes. */
export function useSetting<K extends SettingKey>(key: K, language?: string): Settings[K] {
  useSettings((s) => s.user[key] ?? s.workspace[key]);
  useSettings((s) => (language ? (s.user[`[${language}]`] ?? s.workspace[`[${language}]`]) : null));
  return getSetting(key, language);
}

/** Takes in what Rust says the settings files hold. */
export function applySettings(all: AllSettings) {
  useSettings.setState({
    user: all.user.values,
    workspace: all.workspace?.values ?? {},
    userPath: all.user.path,
    workspacePath: all.workspace?.path ?? null,
    errors: [all.user.error, all.workspace?.error].filter((e): e is string => !!e),
  });
}

/** Changes a setting (`undefined` resets it). Yours by default, or the folder's. */
export function updateSetting<K extends SettingKey>(
  key: K,
  value: Settings[K] | undefined,
  scope: SettingsScope = 'user',
): Promise<void> {
  return updateAnySetting(key, value, scope);
}

/** Changes any key, a plugin's included (`undefined` resets it). */
export async function updateAnySetting(
  key: string,
  value: unknown,
  scope: SettingsScope = 'user',
): Promise<void> {
  try {
    applySettings(await backend().settings.set(scope, { [key]: value ?? null }));
  } catch (err) {
    const { notify } = await import('./notifications');
    notify('error', errorMessage(err));
  }
}

/** Watches for settings changes from Rust (another window, or a saved settings.json). */
export function watchSettings(): () => void {
  return backend().settings.onChange(applySettings);
}
