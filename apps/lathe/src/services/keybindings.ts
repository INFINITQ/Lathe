// Workbench keybindings: Ctrl+P, Ctrl+Shift+P, Ctrl+B, chords such as Ctrl+K Ctrl+O… They
// listen in the capture phase, before the focused element. Editing keys (Ctrl+D, Alt+Up,
// Ctrl+/…) belong to the editor's own CodeMirror keymap and never reach this list.
//
// Keys are written VS Code style: "ctrl+shift+p", "ctrl+k ctrl+s", "alt+left", "f12",
// "ctrl+`". Letters follow the keyboard layout; other keys use their physical position.

import { getCommand } from './commands';
import { contextSnapshot } from './context';
import { evaluate } from './when';

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
  args?: unknown;
}

const NAMED: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Escape: 'escape',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Space: 'space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadAdd: 'numpad_add',
  NumpadSubtract: 'numpad_subtract',
};

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

/** One key press as a normalised string: "ctrl+shift+p". Empty for a lone modifier. */
export function keyOf(event: KeyboardEvent): string {
  if (MODIFIERS.has(event.key)) return '';
  let key: string;
  if (/^Key[A-Z]$/.test(event.code)) {
    // Letters follow the layout (AZERTY's A is "a"), unless the layout gives no letter.
    key = /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() : event.code.slice(3).toLowerCase();
  } else if (/^Digit\d$/.test(event.code)) {
    key = event.code.slice(5);
  } else if (/^Numpad\d$/.test(event.code)) {
    key = `numpad${event.code.slice(6)}`;
  } else if (/^F\d{1,2}$/.test(event.code)) {
    key = event.code.toLowerCase();
  } else {
    key = NAMED[event.code] ?? NAMED[event.key] ?? event.key.toLowerCase();
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  if (event.metaKey) parts.push('meta');
  parts.push(key);
  return parts.join('+');
}

/** "Ctrl+Shift+P" or "ctrl+shift+p" → "ctrl+shift+p" (modifiers in a fixed order). */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((stroke) => {
      // "ctrl++" means the plus key.
      const parts = stroke.endsWith('++')
        ? [...stroke.slice(0, -2).split('+'), '+']
        : stroke.split('+');
      const key = parts.pop() ?? '';
      const mods = new Set(parts);
      return [
        mods.has('ctrl') ? 'ctrl' : '',
        mods.has('shift') ? 'shift' : '',
        mods.has('alt') ? 'alt' : '',
        mods.has('meta') || mods.has('win') ? 'meta' : '',
        key,
      ]
        .filter(Boolean)
        .join('+');
    })
    .join(' ');
}

/** "ctrl+shift+p" → "Ctrl+Shift+P", for menus and the palette. */
export function displayKey(key: string): string {
  return normalizeKey(key)
    .split(' ')
    .map((stroke) =>
      stroke
        .split('+')
        .map((part) =>
          part.length === 1
            ? part.toUpperCase()
            : part
                .replace(/^(\w)/, (c) => c.toUpperCase())
                .replace('Pageup', 'PageUp')
                .replace('Pagedown', 'PageDown'),
        )
        .join('+'),
    )
    .join(' ');
}

let defaults: Keybinding[] = [];
let user: Keybinding[] = [];
/** Keys plugins declare: after yours, before Lathe's own. */
let fromPlugins: Keybinding[] = [];
const listeners = new Set<() => void>();

/** Sets the keybindings plugins declare (all of them, each time plugins change). */
export function setPluginKeybindings(bindings: Keybinding[]) {
  fromPlugins = bindings.map((b) => ({ ...b, key: normalizeKey(b.key) }));
  listeners.forEach((l) => l());
}

/** Sets the built-in keybindings (called once at start-up). */
export function setDefaultKeybindings(bindings: Keybinding[]) {
  defaults = bindings.map((b) => ({ ...b, key: normalizeKey(b.key) }));
  listeners.forEach((l) => l());
}

/**
 * Sets your own keybindings (keybindings.json). A binding whose command starts with "-"
 * removes the default one for that key, as in VS Code.
 */
export function setUserKeybindings(bindings: Keybinding[]) {
  user = bindings.map((b) => ({ ...b, key: normalizeKey(b.key) }));
  listeners.forEach((l) => l());
}

/** Your keybindings.json entries as written ("-command" removals included). */
export function userKeybindingEntries(): readonly Keybinding[] {
  return user;
}

export type KeybindingSource = 'user' | 'plugin' | 'default';

/** Every binding in effect with where it comes from: yours, then plugins', then Lathe's. Your
 * "-command" entries remove a plugin's or Lathe's binding of that key. */
export function keybindingsBySource(): (Keybinding & { source: KeybindingSource })[] {
  const removed = user.filter((b) => b.command.startsWith('-'));
  const kept = (list: Keybinding[]) =>
    list.filter((d) => !removed.some((r) => r.command.slice(1) === d.command && r.key === d.key));
  return [
    ...user
      .filter((b) => !b.command.startsWith('-'))
      .map((b) => ({ ...b, source: 'user' as const })),
    ...kept(fromPlugins).map((b) => ({ ...b, source: 'plugin' as const })),
    ...kept(defaults).map((b) => ({ ...b, source: 'default' as const })),
  ];
}

/** Every binding in effect, yours first. */
export function effectiveKeybindings(): Keybinding[] {
  return keybindingsBySource().map((b) => {
    const binding: Keybinding & { source?: KeybindingSource } = { ...b };
    delete binding.source;
    return binding;
  });
}

let suspended = false;

/** While a shortcut is being recorded, keys go to the recorder instead of running commands. */
export function suspendKeybindings(suspend: boolean) {
  suspended = suspend;
}

/** The key shown next to a command in menus and the palette. */
export function keyFor(command: string): string | undefined {
  const binding = effectiveKeybindings().find((b) => b.command === command);
  return binding ? displayKey(binding.key) : undefined;
}

export function onKeybindingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Pending first half of a chord ("ctrl+k"), shown in the status bar. */
let pendingChord: string | null = null;
let chordTimer: ReturnType<typeof setTimeout> | undefined;
const chordListeners = new Set<(chord: string | null) => void>();

export function onChordChanged(listener: (chord: string | null) => void): () => void {
  chordListeners.add(listener);
  return () => chordListeners.delete(listener);
}

function setChord(chord: string | null) {
  pendingChord = chord;
  if (chordTimer) clearTimeout(chordTimer);
  if (chord) chordTimer = setTimeout(() => setChord(null), 5000);
  chordListeners.forEach((l) => l(chord));
}

/**
 * Finds what a key press means right now. Returns the binding to run, "chord" when the press
 * starts a chord, or undefined when no binding wants it.
 */
export function resolveKey(
  stroke: string,
  ctx = contextSnapshot(),
): Keybinding | 'chord' | undefined {
  const bindings = effectiveKeybindings();
  const full = pendingChord ? `${pendingChord} ${stroke}` : stroke;
  const match = bindings.find((b) => b.key === full && evaluate(b.when, ctx));
  if (match) return match;
  if (
    !pendingChord &&
    bindings.some((b) => b.key.startsWith(`${stroke} `) && evaluate(b.when, ctx))
  ) {
    return 'chord';
  }
  return undefined;
}

/** In a terminal, keys belong to the shell (Ctrl+B, Ctrl+P, Ctrl+K…) except these. */
const TERMINAL_KEYS = new Set([
  'quickOpen.files',
  'quickOpen.commands',
  'view.toggleTerminal',
  'terminal.new',
  'view.togglePanel',
  'view.toggleSidebar',
  'view.toggleZen',
  'editor.nextRecent',
  'editor.previousRecent',
  'view.focusGroup1',
  'view.focusGroup2',
  'view.focusGroup3',
]);

/** Installs the capture-phase listener that runs workbench keybindings. */
export function installKeybindings(run: (command: string, args?: unknown) => void): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.defaultPrevented || suspended) return;
    const stroke = keyOf(event);
    if (!stroke) return;
    const result = resolveKey(stroke);
    const inTerminal = event.target instanceof HTMLElement && !!event.target.closest('.xterm');
    if (result === 'chord') {
      if (inTerminal) return;
      event.preventDefault();
      event.stopPropagation();
      setChord(stroke);
      return;
    }
    const hadChord = pendingChord !== null;
    if (hadChord) setChord(null);
    if (!result) {
      // The second key of an unknown chord is swallowed, as in VS Code.
      if (hadChord) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!getCommand(result.command)) return;
    if (inTerminal && !TERMINAL_KEYS.has(result.command)) return;
    event.preventDefault();
    event.stopPropagation();
    run(result.command, result.args);
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
}
