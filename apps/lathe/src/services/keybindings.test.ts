import { afterEach, describe, expect, it } from 'vitest';
import { registerCommands } from './commands';
import {
  displayKey,
  effectiveKeybindings,
  keyOf,
  keybindingsBySource,
  normalizeKey,
  resolveKey,
  setDefaultKeybindings,
  setPluginKeybindings,
  setUserKeybindings,
} from './keybindings';
import { parseKeybindings } from './userKeybindings';

function press(init: KeyboardEventInit & { code: string; key: string }) {
  return new KeyboardEvent('keydown', init);
}

describe('keybindings', () => {
  afterEach(() => {
    setDefaultKeybindings([]);
    setUserKeybindings([]);
  });

  it('turns key presses into VS Code style strings', () => {
    expect(keyOf(press({ code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true }))).toBe(
      'ctrl+shift+p',
    );
    expect(keyOf(press({ code: 'Backquote', key: '`', ctrlKey: true }))).toBe('ctrl+`');
    expect(keyOf(press({ code: 'Digit1', key: '!', shiftKey: true, altKey: true }))).toBe(
      'shift+alt+1',
    );
    expect(keyOf(press({ code: 'F12', key: 'F12', shiftKey: true }))).toBe('shift+f12');
    expect(keyOf(press({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))).toBe('');
  });

  it('normalises and displays keys', () => {
    expect(normalizeKey('Shift+Ctrl+P')).toBe('ctrl+shift+p');
    expect(normalizeKey('ctrl+K   ctrl+S')).toBe('ctrl+k ctrl+s');
    expect(displayKey('ctrl+shift+p')).toBe('Ctrl+Shift+P');
    expect(displayKey('ctrl+k ctrl+s')).toBe('Ctrl+K Ctrl+S');
    expect(displayKey('alt+pagedown')).toBe('Alt+PageDown');
  });

  it('resolves chords and when clauses', () => {
    registerCommands([
      { id: 'a', title: 'A', run: () => {} },
      { id: 'b', title: 'B', run: () => {} },
    ]);
    setDefaultKeybindings([
      { key: 'ctrl+k ctrl+o', command: 'a' },
      { key: 'ctrl+b', command: 'b', when: 'sidebarVisible' },
    ]);
    expect(resolveKey('ctrl+k', {})).toBe('chord');
    expect(resolveKey('ctrl+b', { sidebarVisible: false })).toBeUndefined();
    expect(resolveKey('ctrl+b', { sidebarVisible: true })).toMatchObject({ command: 'b' });
  });

  it('lets your keybindings add to and remove defaults', () => {
    setDefaultKeybindings([
      { key: 'ctrl+b', command: 'view.toggleSidebar' },
      { key: 'ctrl+j', command: 'view.togglePanel' },
    ]);
    setUserKeybindings([
      { key: 'ctrl+alt+b', command: 'view.toggleSidebar' },
      { key: 'ctrl+j', command: '-view.togglePanel' },
    ]);
    const keys = effectiveKeybindings().map((b) => `${b.key}=${b.command}`);
    expect(keys).toEqual(['ctrl+alt+b=view.toggleSidebar', 'ctrl+b=view.toggleSidebar']);
  });

  it('reads keybindings.json, comments and bad entries included', () => {
    const { bindings, problem } = parseKeybindings(`// mine
      [
        { "key": "ctrl+alt+t", "command": "terminal.new" }, // a terminal
        { "key": "ctrl+,", "command": "-preferences.openSettings", "when": "" },
        { "command": "no.key" },
      ]`);
    expect(bindings).toEqual([
      { key: 'ctrl+alt+t', command: 'terminal.new' },
      { key: 'ctrl+,', command: '-preferences.openSettings' },
    ]);
    expect(problem).toBe('Entry 3 needs a "key" and a "command".');
    expect(parseKeybindings('{').bindings).toBeNull();
    expect(parseKeybindings('{}').bindings).toBeNull();
    expect(parseKeybindings('').bindings).toEqual([]);
  });

  it('says where each binding comes from, yours first', () => {
    setDefaultKeybindings([
      { key: 'ctrl+b', command: 'view.toggleSidebar' },
      { key: 'ctrl+j', command: 'view.togglePanel' },
    ]);
    setPluginKeybindings([{ key: 'ctrl+alt+w', command: 'wordCount.count' }]);
    setUserKeybindings([
      { key: 'ctrl+shift+b', command: 'view.toggleSidebar' },
      { key: 'ctrl+b', command: '-view.toggleSidebar' },
      { key: 'ctrl+alt+w', command: '-wordCount.count' },
    ]);
    expect(keybindingsBySource().map((b) => `${b.source}:${b.key}=${b.command}`)).toEqual([
      'user:ctrl+shift+b=view.toggleSidebar',
      'default:ctrl+j=view.togglePanel',
    ]);
    setPluginKeybindings([]);
  });
});
