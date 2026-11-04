// Appearance: light or dark, the accent colour and the editor font, applied as CSS variables
// so everything (React, CodeMirror, xterm) follows without re-rendering.

import { type Accent, getSetting } from '../services/settings';
import { backend } from './backend';

export type ThemeSetting = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** The theme to show: an explicit choice wins, "system" follows Windows. */
export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ResolvedTheme {
  if (setting === 'system') return systemDark ? 'dark' : 'light';
  return setting;
}

/** Switches the document's design tokens (styles/tokens.css keys them on `data-theme`). */
export function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** Calls `listener` whenever Windows switches between light and dark. */
export function watchSystemTheme(listener: (dark: boolean) => void): () => void {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const onChange = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Accent colours: the fill, the colour for text and icons, and the ink on top of the fill. */
const ACCENTS: Record<Accent, { dark: [string, string, string]; light: [string, string, string] }> =
  {
    lime: { dark: ['#d9f99d', '#d9f99d', '#0a0a0b'], light: ['#d9f99d', '#4d7c0f', '#1a2e05'] },
    mint: { dark: ['#a7f3d0', '#6ee7b7', '#022c22'], light: ['#a7f3d0', '#047857', '#022c22'] },
    sky: { dark: ['#bae6fd', '#7dd3fc', '#082f49'], light: ['#bae6fd', '#0369a1', '#082f49'] },
    violet: { dark: ['#ddd6fe', '#c4b5fd', '#2e1065'], light: ['#ddd6fe', '#6d28d9', '#2e1065'] },
    rose: { dark: ['#fecdd3', '#fda4af', '#4c0519'], light: ['#fecdd3', '#be123c', '#4c0519'] },
    amber: { dark: ['#fde68a', '#fcd34d', '#451a03'], light: ['#fde68a', '#b45309', '#451a03'] },
  };

let systemIsDark = backend().boot().systemDark;
let lastDark: boolean | null = null;

/** A plugin's colour theme: light or dark underneath, and the tokens it changes. */
export interface ThemeOverride {
  base: ResolvedTheme;
  vars: Record<string, string>;
}

let override: ThemeOverride | null = null;
let overridden: string[] = [];
/** Variables applyAppearance sets itself (they come back on their own). */
const OWN = new Set(['--accent', '--accent-fg', '--accent-ink', '--selection']);

/** Puts a plugin's colour theme on top of Mono (null goes back to Mono). */
export function setThemeOverride(next: ThemeOverride | null) {
  override = next;
  applyAppearance();
}

export function setSystemDark(dark: boolean) {
  systemIsDark = dark;
  applyAppearance();
}

/** Applies the theme, accent and editor font settings. */
export function applyAppearance() {
  const theme = override?.base ?? resolveTheme(getSetting('workbench.theme'), systemIsDark);
  applyTheme(theme);
  const style = document.documentElement.style;
  const accent = ACCENTS[getSetting('workbench.accent')] ?? ACCENTS.lime;
  const [fill, fg, ink] = accent[theme];
  style.setProperty('--accent', fill);
  style.setProperty('--accent-fg', fg);
  style.setProperty('--accent-ink', ink);
  style.setProperty('--accent-soft', `color-mix(in srgb, ${fg} 10%, transparent)`);
  style.setProperty(
    '--selection',
    `color-mix(in srgb, ${fg} ${theme === 'dark' ? 16 : 20}%, transparent)`,
  );
  style.setProperty('--focus', `color-mix(in srgb, ${fg} 55%, transparent)`);
  const family = getSetting('editor.fontFamily').trim();
  if (family) style.setProperty('--font-code', `${family}, var(--font-mono)`);
  else style.removeProperty('--font-code');
  style.setProperty('--code-size', `${getSetting('editor.fontSize')}px`);
  style.setProperty('--code-line-height', String(getSetting('editor.lineHeight')));
  style.setProperty('--code-ligatures', getSetting('editor.fontLigatures') ? 'normal' : 'none');
  // A plugin theme's colours go last, over the accent too; the ones it no longer sets go away.
  for (const name of overridden) {
    if (!override?.vars[name] && !OWN.has(name)) style.removeProperty(name);
  }
  overridden = Object.keys(override?.vars ?? {});
  for (const [name, value] of Object.entries(override?.vars ?? {})) style.setProperty(name, value);
  const dark = theme === 'dark';
  if (dark !== lastDark) {
    lastDark = dark;
    void backend().setWindowDark(dark);
  }
}
