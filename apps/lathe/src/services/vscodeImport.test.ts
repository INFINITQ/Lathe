import { describe, expect, it } from 'vitest';
import { mapVsCodeKeybindings, mapVsCodeSettings } from './vscodeImport';

describe('Import from VS Code', () => {
  it('translates the settings Lathe has, language sections included', () => {
    const { values, imported, skipped } = mapVsCodeSettings({
      'editor.fontSize': 15,
      'editor.lineHeight': 24,
      'editor.wordWrap': 'bounded',
      'editor.renderWhitespace': 'selection',
      'editor.cursorBlinking': 'solid',
      'editor.matchBrackets': 'near',
      'files.autoSave': 'onWindowChange',
      'files.exclude': { '**/.git': true, '**/x': { when: '$(basename).ts' } },
      'workbench.colorTheme': 'Default Light Modern',
      'editor.tabSize': 'four',
      'python.defaultInterpreterPath': 'C:/py',
      '[python]': { 'editor.tabSize': 4, 'editor.defaultFormatter': 'ms-python.black' },
      '[go]': { 'editor.formatOnSave': 'yes' },
    });
    expect(values).toEqual({
      'editor.fontSize': 15,
      'editor.lineHeight': 1.6,
      'editor.wordWrap': 'on',
      'editor.renderWhitespace': 'none',
      'editor.cursorBlinking': false,
      'editor.matchBrackets': true,
      'files.autoSave': 'onFocusChange',
      'files.exclude': { '**/.git': true },
      'workbench.theme': 'light',
      '[python]': { 'editor.tabSize': 4 },
    });
    expect(imported).toBe(10);
    // "four", the interpreter, the formatter, and Go's "yes".
    expect(skipped).toBe(4);
  });

  it('follows Windows when VS Code does', () => {
    const { values } = mapVsCodeSettings({
      'window.autoDetectColorScheme': true,
      'workbench.colorTheme': 'Default Dark Modern',
    });
    expect(values).toEqual({ 'workbench.theme': 'system' });
  });

  it("maps VS Code's commands to Lathe's and keeps removals", () => {
    const known = new Set([
      'quickOpen.files',
      'view.toggleSidebar',
      'git.commit',
      'editor.toggleComment',
    ]);
    const { bindings, skipped } = mapVsCodeKeybindings(
      [
        { key: 'ctrl+e', command: 'workbench.action.quickOpen' },
        { key: 'ctrl+b', command: '-workbench.action.toggleSidebarVisibility' },
        { key: 'ctrl+alt+c', command: 'git.commit', when: 'scmRepository' },
        { key: 'ctrl+/', command: 'editor.action.commentLine', when: '' },
        { key: 'ctrl+k ctrl+x', command: 'some.extension.command' },
        { command: 'no.key' },
      ],
      (id) => known.has(id),
    );
    expect(bindings).toEqual([
      { key: 'ctrl+e', command: 'quickOpen.files' },
      { key: 'ctrl+b', command: '-view.toggleSidebar' },
      { key: 'ctrl+alt+c', command: 'git.commit', when: 'scmRepository' },
      { key: 'ctrl+/', command: 'editor.toggleComment' },
    ]);
    expect(skipped).toBe(2);
  });
});
