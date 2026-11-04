// Colour themes from plugins, in VS Code's colour-theme format ("colors" and "tokenColors"),
// mapped onto Lathe's design tokens: workbench colours to --bg, --text, --accent and the rest,
// token colours to the --syn-* syntax colours. Mono stays the default.

import { parseJsonc } from '../lib/jsonc';
import { type ThemeOverride, setThemeOverride } from '../lib/theme';
import { backend, errorMessage } from '../lib/backend';
import { notify } from '../services/notifications';
import { getSetting } from '../services/settings';

export interface PluginTheme {
  /** "<plugin id>:<label>", as workbench.colorTheme names it. */
  key: string;
  label: string;
  plugin: string;
  base: 'dark' | 'light';
  path: string;
}

const themes = new Map<string, PluginTheme>();
const loaded = new Map<string, ThemeOverride>();

export function pluginThemes(): PluginTheme[] {
  return [...themes.values()];
}

export function addThemes(plugin: string, list: unknown) {
  for (const item of Array.isArray(list) ? list : []) {
    const theme = item as { label?: unknown; uiTheme?: unknown; path?: unknown };
    if (typeof theme.label !== 'string' || typeof theme.path !== 'string') continue;
    const base = theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light' ? 'light' : 'dark';
    const key = `${plugin}:${theme.label}`;
    themes.set(key, { key, label: theme.label, plugin, base, path: theme.path });
  }
}

export function removeThemes(plugin: string) {
  for (const [key, theme] of themes) {
    if (theme.plugin === plugin) {
      themes.delete(key);
      loaded.delete(key);
    }
  }
  void applyColorTheme();
}

/** Workbench colours (VS Code's names, first match wins) for each Lathe token. */
const COLORS: Record<string, string[]> = {
  '--bg': ['editor.background'],
  '--bg-raised': ['sideBar.background', 'editorWidget.background', 'panel.background'],
  '--bg-overlay': ['editorWidget.background', 'menu.background', 'dropdown.background'],
  '--hover': ['list.hoverBackground', 'toolbar.hoverBackground'],
  '--active': ['list.activeSelectionBackground', 'list.inactiveSelectionBackground'],
  '--line': ['editorGroup.border', 'panel.border', 'sideBar.border', 'editorWidget.border'],
  '--line-strong': ['input.border', 'focusBorder', 'contrastBorder'],
  '--text': ['editor.foreground', 'foreground'],
  '--text-2': ['sideBar.foreground', 'descriptionForeground'],
  '--text-3': ['descriptionForeground', 'editorLineNumber.foreground'],
  '--text-4': ['editorLineNumber.foreground', 'disabledForeground'],
  '--accent': ['button.background', 'focusBorder', 'textLink.foreground'],
  '--accent-fg': ['textLink.foreground', 'focusBorder', 'button.background'],
  '--accent-ink': ['button.foreground'],
  '--selection': ['editor.selectionBackground'],
  '--danger': ['errorForeground', 'editorError.foreground'],
  '--warning': ['editorWarning.foreground', 'list.warningForeground'],
};

/** TextMate scopes (first match wins) for each syntax colour. */
const SCOPES: Record<string, string[]> = {
  '--syn-comment': ['comment'],
  '--syn-string': ['string'],
  '--syn-keyword': ['keyword', 'storage', 'keyword.control'],
  '--syn-number': ['constant.numeric', 'constant'],
  '--syn-function': ['entity.name.function', 'support.function'],
  '--syn-type': ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  '--syn-variable': ['variable', 'variable.other'],
  '--syn-punct': ['punctuation'],
  '--syn-meta': ['meta.decorator', 'entity.name.tag', 'meta.preprocessor'],
};

interface VsTheme {
  colors?: Record<string, unknown>;
  tokenColors?: { scope?: string | string[]; settings?: { foreground?: unknown } }[];
}

function tokenColor(theme: VsTheme, wanted: string): string | undefined {
  // A rule for the scope itself beats one for a broader scope.
  let best: { length: number; color: string } | undefined;
  for (const rule of theme.tokenColors ?? []) {
    const color = rule.settings?.foreground;
    if (typeof color !== 'string') continue;
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : String(rule.scope ?? '')
          .split(',')
          .map((s) => s.trim());
    for (const scope of scopes) {
      if (wanted === scope || wanted.startsWith(`${scope}.`)) {
        if (!best || scope.length > best.length) best = { length: scope.length, color };
      }
    }
  }
  return best?.color;
}

export function themeVariables(theme: VsTheme): Record<string, string> {
  const vars: Record<string, string> = {};
  const colors = theme.colors ?? {};
  for (const [token, names] of Object.entries(COLORS)) {
    const color = names.map((n) => colors[n]).find((c): c is string => typeof c === 'string');
    if (color) vars[token] = color;
  }
  for (const [token, scopes] of Object.entries(SCOPES)) {
    const color = scopes.map((s) => tokenColor(theme, s)).find(Boolean);
    if (color) vars[token] = color;
  }
  return vars;
}

/** Applies workbench.colorTheme: a plugin's theme, or Mono when it names none. */
export async function applyColorTheme() {
  const key = getSetting('workbench.colorTheme');
  const theme = key ? themes.get(key) : undefined;
  if (!theme) {
    setThemeOverride(null);
    return;
  }
  let override = loaded.get(key);
  if (!override) {
    try {
      const text = await backend().plugins.readText(theme.plugin, theme.path);
      override = { base: theme.base, vars: themeVariables(parseJsonc<VsTheme>(text)) };
      loaded.set(key, override);
    } catch (err) {
      notify('error', `Couldn't load the theme ${theme.label}.`, { detail: errorMessage(err) });
      setThemeOverride(null);
      return;
    }
  }
  if (getSetting('workbench.colorTheme') === key) setThemeOverride(override);
}
