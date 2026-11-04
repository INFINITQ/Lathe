// "Import from VS Code": your VS Code settings, keybindings and user snippets, translated to
// Lathe's where they have a counterpart. Offered once on the first run (when VS Code is there and
// Lathe has nothing of yours yet), and always in the palette.

import { backend, errorMessage } from '../lib/backend';
import { parseJsonc } from '../lib/jsonc';
import { join } from '../lib/paths';
import type { Keybinding } from './keybindings';
import { notify } from './notifications';
import { DEFAULT_SETTINGS, applySettings, useSettings } from './settings';
import { addKeybindings, keybindingsPath } from './userKeybindings';
import { loadUserSnippets, snippetsDir } from './userSnippets';

type Values = Record<string, unknown>;
type Convert = (value: unknown, all: Values) => unknown;

const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
/** A VS Code choice that Lathe has as on/off: off for the values listed. */
const offFor =
  (...off: unknown[]) =>
  (v: unknown) =>
    typeof v === 'boolean' ? v : typeof v === 'string' ? !off.includes(v) : undefined;
const oneOf = (map: Record<string, string>) => (v: unknown) =>
  typeof v === 'string' ? map[v] : undefined;
/** `{ "**\/.git": true, "**\/x": { "when": … } }` → the plain on/off patterns. */
const patterns = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [pattern, on] of Object.entries(v as Values))
    if (typeof on === 'boolean') out[pattern] = on;
  return out;
};

/** VS Code's setting → Lathe's, and how to translate the value (undefined: can't). */
const SETTINGS: Record<string, [string, Convert]> = {
  'editor.fontFamily': ['editor.fontFamily', str],
  'editor.fontSize': ['editor.fontSize', num],
  // VS Code's line height is pixels (or a multiple when below 8); Lathe's is a multiple.
  'editor.lineHeight': [
    'editor.lineHeight',
    (v, all) => {
      if (typeof v !== 'number' || v <= 0) return undefined;
      if (v < 8) return v;
      const size = typeof all['editor.fontSize'] === 'number' ? all['editor.fontSize'] : 14;
      return Math.round((v / size) * 100) / 100;
    },
  ],
  'editor.fontLigatures': ['editor.fontLigatures', (v) => (typeof v === 'string' ? !!v : bool(v))],
  'editor.tabSize': ['editor.tabSize', num],
  'editor.insertSpaces': ['editor.insertSpaces', bool],
  'editor.detectIndentation': ['editor.detectIndentation', bool],
  'editor.wordWrap': [
    'editor.wordWrap',
    (v) => (v === 'off' ? 'off' : typeof v === 'string' ? 'on' : undefined),
  ],
  'editor.lineNumbers': [
    'editor.lineNumbers',
    oneOf({ on: 'on', off: 'off', relative: 'relative', interval: 'on' }),
  ],
  'editor.minimap.enabled': ['editor.minimap.enabled', bool],
  'editor.renderWhitespace': [
    'editor.renderWhitespace',
    oneOf({ none: 'none', selection: 'none', boundary: 'all', trailing: 'trailing', all: 'all' }),
  ],
  'editor.renderLineHighlight': ['editor.renderLineHighlight', offFor('none')],
  'editor.cursorBlinking': ['editor.cursorBlinking', offFor('solid')],
  'editor.guides.indentation': ['editor.guides.indentation', bool],
  'editor.matchBrackets': ['editor.matchBrackets', offFor('never')],
  'editor.autoClosingBrackets': ['editor.autoClosingBrackets', offFor('never')],
  'editor.folding': ['editor.folding', bool],
  'editor.scrollBeyondLastLine': ['editor.scrollBeyondLastLine', bool],
  'editor.formatOnSave': ['editor.formatOnSave', bool],
  'editor.largeFileOptimizations': ['editor.largeFileOptimizations', bool],
  'editor.stickyScroll.enabled': ['editor.stickyScroll.enabled', bool],
  'editor.inlayHints.enabled': ['editor.inlayHints.enabled', offFor('off', 'offUnlessPressed')],
  'files.autoSave': [
    'files.autoSave',
    oneOf({
      off: 'off',
      afterDelay: 'afterDelay',
      onFocusChange: 'onFocusChange',
      onWindowChange: 'onFocusChange',
    }),
  ],
  'files.autoSaveDelay': ['files.autoSaveDelay', num],
  'files.trimTrailingWhitespace': ['files.trimTrailingWhitespace', bool],
  'files.insertFinalNewline': ['files.insertFinalNewline', bool],
  'files.hotExit': ['files.hotExit', offFor('off')],
  'files.exclude': ['files.exclude', patterns],
  'explorer.confirmDelete': ['explorer.confirmDelete', bool],
  'explorer.confirmDragAndDrop': ['explorer.confirmDragAndDrop', bool],
  'explorer.autoReveal': ['explorer.autoReveal', (v) => (typeof v === 'string' ? true : bool(v))],
  'search.exclude': ['search.exclude', patterns],
  'search.useIgnoreFiles': ['search.useIgnoreFiles', bool],
  'search.searchOnType': ['search.searchOnType', bool],
  'search.searchOnTypeDebouncePeriod': ['search.searchOnTypeDebouncePeriod', num],
  'search.maxResults': ['search.maxResults', num],
  'workbench.editor.showTabs': ['workbench.editor.showTabs', offFor('none')],
  'workbench.editor.enablePreview': ['workbench.editor.enablePreview', bool],
  'workbench.activityBar.visible': ['workbench.activityBar.visible', bool],
  'workbench.activityBar.location': ['workbench.activityBar.visible', offFor('hidden')],
  'workbench.statusBar.visible': ['workbench.statusBar.visible', bool],
  'workbench.startupEditor': [
    'workbench.startupEditor',
    (v) => (v === 'none' ? 'none' : typeof v === 'string' ? 'welcome' : undefined),
  ],
  'breadcrumbs.symbolPath': ['breadcrumbs.symbolPath', offFor('off')],
  'git.blame.editorDecoration.enabled': ['git.blame.inline', bool],
  'window.autoDetectColorScheme': ['workbench.theme', (v) => (v === true ? 'system' : undefined)],
  // A colour theme's name says light or dark often enough to follow it.
  'workbench.colorTheme': [
    'workbench.theme',
    (v, all) => {
      if (all['window.autoDetectColorScheme'] === true || typeof v !== 'string') return undefined;
      if (/light/i.test(v)) return 'light';
      if (/dark|night|monokai|dracula|abyss|black|one /i.test(v)) return 'dark';
      return undefined;
    },
  ],
};

/** Lathe's value is the kind its default is. */
function fits(key: string, value: unknown): boolean {
  const fallback = (DEFAULT_SETTINGS as Values)[key];
  if (value === undefined || fallback === undefined) return false;
  if (Array.isArray(fallback)) return Array.isArray(value);
  return typeof value === typeof fallback;
}

function translate(values: Values, all: Values): { values: Values; used: string[] } {
  const out: Values = {};
  const used: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const rule = SETTINGS[key];
    if (!rule) continue;
    const [target, convert] = rule;
    const next = convert(value, all);
    if (fits(target, next)) {
      out[target] = next;
      used.push(key);
    }
  }
  return { values: out, used };
}

/** VS Code settings → Lathe's: what has a counterpart (language sections too), and what didn't. */
export function mapVsCodeSettings(raw: Values): {
  values: Values;
  imported: number;
  skipped: number;
} {
  const top = translate(raw, raw);
  let imported = top.used.length;
  let total = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (/^\[[^\]]+\]$/.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const section = translate(value as Values, { ...raw, ...(value as Values) });
      total += Object.keys(value as Values).length;
      if (section.used.length) {
        top.values[key] = section.values;
        imported += section.used.length;
      }
    } else total++;
  }
  return { values: top.values, imported, skipped: total - imported };
}

/** VS Code's command ids → Lathe's. Ids that are the same in both (editor.action.rename,
 * git.commit, markdown.showPreview…) pass through as they are. */
const COMMANDS: Record<string, string> = {
  'workbench.action.quickOpen': 'quickOpen.files',
  'workbench.action.showCommands': 'quickOpen.commands',
  'workbench.action.gotoLine': 'quickOpen.goToLine',
  'workbench.action.gotoSymbol': 'quickOpen.symbols',
  'workbench.action.showAllSymbols': 'quickOpen.workspaceSymbols',
  'workbench.action.files.save': 'file.save',
  'workbench.action.files.saveAll': 'file.saveAll',
  'workbench.action.files.saveAs': 'file.saveAs',
  'workbench.action.files.newUntitledFile': 'file.new',
  'workbench.action.files.openFile': 'file.openFile',
  'workbench.action.files.openFolder': 'file.openFolder',
  'workbench.action.files.revert': 'file.revert',
  'workbench.action.closeFolder': 'file.closeFolder',
  'workbench.action.closeActiveEditor': 'editor.close',
  'workbench.action.closeAllEditors': 'editor.closeAll',
  'workbench.action.reopenClosedEditor': 'editor.reopenClosed',
  'workbench.action.nextEditor': 'editor.next',
  'workbench.action.previousEditor': 'editor.previous',
  'workbench.action.openNextRecentlyUsedEditorInGroup': 'editor.nextRecent',
  'workbench.action.openPreviousRecentlyUsedEditorInGroup': 'editor.previousRecent',
  'workbench.action.toggleSidebarVisibility': 'view.toggleSidebar',
  'workbench.action.togglePanel': 'view.togglePanel',
  'workbench.action.terminal.toggleTerminal': 'view.toggleTerminal',
  'workbench.action.terminal.new': 'terminal.new',
  'workbench.action.toggleZenMode': 'view.toggleZen',
  'workbench.action.exitZenMode': 'view.exitZen',
  'workbench.action.splitEditor': 'view.splitRight',
  'workbench.action.splitEditorRight': 'view.splitRight',
  'workbench.action.splitEditorDown': 'view.splitDown',
  'workbench.action.focusFirstEditorGroup': 'view.focusGroup1',
  'workbench.action.focusSecondEditorGroup': 'view.focusGroup2',
  'workbench.action.focusThirdEditorGroup': 'view.focusGroup3',
  'workbench.view.explorer': 'view.explorer',
  'workbench.view.search': 'view.search',
  'workbench.action.findInFiles': 'view.search',
  'workbench.view.scm': 'view.scm',
  'workbench.view.debug': 'view.debug',
  'workbench.view.extensions': 'view.plugins',
  'workbench.actions.view.problems': 'view.problems',
  'workbench.action.output.toggleOutput': 'view.output',
  'workbench.debug.action.toggleRepl': 'view.debugConsole',
  'workbench.action.navigateBack': 'nav.back',
  'workbench.action.navigateForward': 'nav.forward',
  'workbench.action.openSettings': 'preferences.openSettings',
  'workbench.action.openSettings2': 'preferences.openSettings',
  'workbench.action.openSettingsJson': 'preferences.openSettingsJson',
  'workbench.action.openGlobalKeybindings': 'preferences.openKeybindings',
  'workbench.action.openGlobalKeybindingsFile': 'preferences.openKeybindingsJson',
  'workbench.action.selectTheme': 'workbench.colorTheme',
  'workbench.action.closeWindow': 'window.close',
  'workbench.action.tasks.build': 'tasks.build',
  'workbench.action.tasks.test': 'tasks.test',
  'workbench.action.tasks.runTask': 'tasks.run',
  'workbench.action.tasks.reRunTask': 'tasks.rerun',
  'workbench.action.debug.start': 'debug.start',
  'workbench.action.debug.run': 'run.file',
  'workbench.action.debug.stop': 'debug.stop',
  'workbench.action.debug.restart': 'debug.restart',
  'workbench.action.debug.continue': 'debug.continue',
  'workbench.action.debug.pause': 'debug.pause',
  'workbench.action.debug.stepOver': 'debug.stepOver',
  'workbench.action.debug.stepInto': 'debug.stepInto',
  'workbench.action.debug.stepOut': 'debug.stepOut',
  'editor.debug.action.toggleBreakpoint': 'debug.toggleBreakpoint',
  'editor.debug.action.conditionalBreakpoint': 'debug.addConditionalBreakpoint',
  'editor.debug.action.addLogPoint': 'debug.addLogpoint',
  'editor.action.commentLine': 'editor.toggleComment',
  'editor.action.addCommentLine': 'editor.addLineComment',
  'editor.action.removeCommentLine': 'editor.removeLineComment',
  'editor.action.blockComment': 'editor.toggleBlockComment',
  'editor.action.copyLinesDownAction': 'editor.copyLineDown',
  'editor.action.copyLinesUpAction': 'editor.copyLineUp',
  'editor.action.moveLinesDownAction': 'editor.moveLineDown',
  'editor.action.moveLinesUpAction': 'editor.moveLineUp',
  'editor.action.insertCursorAbove': 'editor.addCursorAbove',
  'editor.action.insertCursorBelow': 'editor.addCursorBelow',
  'editor.action.addSelectionToNextFindMatch': 'editor.addNextOccurrence',
  'editor.action.selectHighlights': 'editor.selectAllOccurrences',
  'editor.action.smartSelect.expand': 'editor.expandSelection',
  'editor.action.toggleMinimap': 'view.toggleMinimap',
  'editor.action.toggleWordWrap': 'view.toggleWordWrap',
  'actions.find': 'edit.find',
  'editor.action.startFindReplaceAction': 'edit.replace',
  undo: 'edit.undo',
  redo: 'edit.redo',
  'editor.action.selectAll': 'edit.selectAll',
};

/** VS Code keybindings → Lathe's: those whose command Lathe has (by `known`). */
export function mapVsCodeKeybindings(
  raw: unknown,
  known: (command: string) => boolean,
): { bindings: Keybinding[]; skipped: number } {
  const bindings: Keybinding[] = [];
  let skipped = 0;
  for (const entry of Array.isArray(raw) ? raw : []) {
    const e = entry as { key?: unknown; command?: unknown; when?: unknown; args?: unknown } | null;
    if (!e || typeof e.key !== 'string' || typeof e.command !== 'string' || !e.command) {
      skipped++;
      continue;
    }
    const removal = e.command.startsWith('-');
    const id = removal ? e.command.slice(1) : e.command;
    const command = COMMANDS[id] ?? id;
    if (!known(command)) {
      skipped++;
      continue;
    }
    bindings.push({
      key: e.key,
      command: removal ? `-${command}` : command,
      ...(typeof e.when === 'string' && e.when.trim() ? { when: e.when } : {}),
      ...(e.args !== undefined ? { args: e.args } : {}),
    });
  }
  return { bindings, skipped };
}

async function readJsonc<T>(path: string): Promise<T | null> {
  if (!(await backend().fs.stat(path))) return null;
  return parseJsonc<T>((await backend().fs.readText(path)).text);
}

/** Brings in VS Code's settings, keybindings and snippets; says what came across. */
export async function importFromVsCode(): Promise<void> {
  const dir = await backend().vscodeUserDir();
  if (!dir) {
    notify('info', "Lathe didn't find VS Code's settings on this PC.");
    return;
  }
  const done: string[] = [];
  const problems: string[] = [];

  try {
    const raw = await readJsonc<Values>(join(dir, 'settings.json'));
    if (raw && typeof raw === 'object') {
      const { values, imported } = mapVsCodeSettings(raw);
      if (imported) {
        applySettings(await backend().settings.set('user', values));
        done.push(`${imported} setting${imported === 1 ? '' : 's'}`);
      }
    }
  } catch (err) {
    problems.push(`settings.json: ${errorMessage(err)}`);
  }

  try {
    const raw = await readJsonc<unknown>(join(dir, 'keybindings.json'));
    if (raw) {
      const { getCommand } = await import('./commands');
      const { bindings } = mapVsCodeKeybindings(raw, (id) => !!getCommand(id));
      const added = bindings.length ? await addKeybindings(bindings) : 0;
      if (added) done.push(`${added} keybinding${added === 1 ? '' : 's'}`);
    }
  } catch (err) {
    problems.push(`keybindings.json: ${errorMessage(err)}`);
  }

  try {
    const from = join(dir, 'snippets');
    const entries = (await backend().fs.stat(from)) ? await backend().fs.readDir(from) : [];
    const files = entries.filter((e) => !e.dir && /\.(json|code-snippets)$/i.test(e.name));
    if (files.length) {
      const to = snippetsDir();
      if (!(await backend().fs.stat(to))) await backend().fs.createDir(to);
      let copied = 0;
      for (const file of files) {
        const target = join(to, file.name);
        // Snippet files you already have in Lathe stay as they are.
        if (await backend().fs.stat(target)) continue;
        const { text } = await backend().fs.readText(join(from, file.name));
        await backend().fs.writeText(target, text, null, null, false);
        copied++;
      }
      if (copied) {
        await loadUserSnippets();
        done.push(`${copied} snippet file${copied === 1 ? '' : 's'}`);
      }
    }
  } catch (err) {
    problems.push(`snippets: ${errorMessage(err)}`);
  }

  if (problems.length) {
    notify(
      'warning',
      done.length
        ? `Imported ${list(done)}; some of it didn't come across.`
        : "Couldn't import from VS Code.",
      {
        detail: problems.join('\n'),
      },
    );
  } else if (done.length) {
    notify('success', `Imported ${list(done)} from VS Code.`);
  } else {
    notify('info', 'VS Code had nothing Lathe could bring in.');
  }
}

const list = (parts: string[]) =>
  parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');

/** On the first run: offer the import when VS Code is there and Lathe has nothing of yours. */
export async function offerVsCodeImport(): Promise<void> {
  const flag = join(backend().boot().dataDir, 'vscode-import-offered');
  try {
    if (await backend().fs.stat(flag)) return;
    if (Object.keys(useSettings.getState().user).length > 0) return;
    if (await backend().fs.stat(keybindingsPath())) return;
    const dir = await backend().vscodeUserDir();
    if (!dir) return;
    await backend().fs.writeText(flag, '', null, null, false);
  } catch {
    return;
  }
  notify('info', 'Bring your VS Code settings, keybindings and snippets?', {
    actions: [
      { label: 'Import', run: () => importFromVsCode() },
      { label: 'Not now', run: () => {} },
    ],
  });
}
