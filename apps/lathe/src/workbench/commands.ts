// The workbench's commands and their default keys (VS Code's, wherever that makes sense).

import {
  copyLineDown,
  copyLineUp,
  lineComment,
  lineUncomment,
  moveLineDown,
  moveLineUp,
  redo,
  selectAll,
  selectParentSyntax,
  toggleBlockComment,
  toggleComment,
  undo,
} from '@codemirror/commands';
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language';
import { selectNextOccurrence, selectSelectionMatches } from '@codemirror/search';
import { openFind, openReplace } from '../editor/find';
import type { Command as EditorCommand, EditorView } from '@codemirror/view';
import { getActiveDoc, getActiveView } from '../editor/active';
import { allDocuments, dirtyDocuments, reloadDocument, saveDocument } from '../editor/documents';
import { addCursor } from '../editor/keymap';
import { LANGUAGES, languageIdOf, languageNameOf } from '../editor/languages';
import { ensureLanguage, reconfigureEditor } from '../editor/setup';
import { backend } from '../lib/backend';
import { join } from '../lib/paths';
import { type Command, registerCommands } from '../services/commands';
import type { Keybinding } from '../services/keybindings';
import { notify } from '../services/notifications';
import { getSetting, updateSetting, useSettings } from '../services/settings';
import {
  activeTab,
  closeAllEditors,
  closeTab,
  cycleTab,
  focusGroupAt,
  newUntitled,
  openPath,
  openPreview,
  reopenClosed,
  showEditorTab,
  splitGroup,
} from './editors/store';
import { showStartupReport } from '../services/startup';
import { ensureKeybindingsFile } from '../services/userKeybindings';
import { snippetsFileFor } from '../services/userSnippets';
import { importFromVsCode } from '../services/vscodeImport';
import { revealActiveFile } from './explorer/Explorer';
import {
  collapseAll,
  copySelected,
  deleteSelected,
  paste,
  startCreate,
  startRename,
} from './explorer/tree';
import { showPanel, showView, toggleSidebar, togglePanel, toggleZen, useLayout } from './layout';
import { openQuickOpen, quickPick } from './quickinput/store';
import { newTerminal, toggleTerminal } from './terminal/store';
import { runActiveFile } from '../run/run';
import {
  LSPPlugin,
  findReferences,
  formatDocument,
  jumpToDeclaration,
  jumpToDefinition,
  jumpToImplementation,
  jumpToTypeDefinition,
  showSignatureHelp,
} from '@codemirror/lsp-client';
import { renameSymbolAt, showCodeActions } from '../lsp/features';
import {
  pickServerToInstall,
  restartActiveServer,
  showActiveServerOutput,
  stopActiveServer,
} from '../lsp/manager';
import {
  commit as gitCommit,
  initRepository,
  refreshGit,
  remote as gitRemote,
  showGitOutput,
  stage as gitStage,
  stash as gitStash,
  statusOf,
  unstage as gitUnstage,
} from '../services/git';
import { goBack, goForward } from '../services/navigation';
import {
  createBranch,
  openChange,
  pickBranchToDelete,
  showBranchPicker,
  showFileHistory,
  showLocalHistory,
} from './scm/actions';
import { clearSearch, focusSearch, goToMatch } from '../services/search';
import { configureTasks, rerunLastTask, runGroupTask, runTaskCommand } from '../run/tasks';
import { closeFolder, openFolder, pickAndOpenFolder, useWorkspace } from './workspaceStore';
import { DEBUG_KEYBINDINGS, registerDebugCommands } from '../debug/commands';
import { registerNotebookCommands } from '../notebook/commands';
import { registerPluginCommands } from '../plugins/commands';

/** Runs a CodeMirror command on the editor you're in, and keeps the focus there. */
function inEditor(command: EditorCommand) {
  return () => {
    const view = getActiveView();
    if (!view) return;
    command(view);
    view.focus();
  };
}

const ENCODINGS = [
  { label: 'UTF-8', encoding: 'UTF-8', bom: false },
  { label: 'UTF-8 with BOM', encoding: 'UTF-8', bom: true },
  { label: 'UTF-16 LE', encoding: 'UTF-16LE', bom: true },
  { label: 'UTF-16 BE', encoding: 'UTF-16BE', bom: true },
  { label: 'Western (Windows 1252)', encoding: 'windows-1252', bom: false },
  { label: 'Central European (Windows 1250)', encoding: 'windows-1250', bom: false },
  { label: 'Cyrillic (Windows 1251)', encoding: 'windows-1251', bom: false },
  { label: 'Japanese (Shift JIS)', encoding: 'Shift_JIS', bom: false },
  { label: 'Chinese (GBK)', encoding: 'GBK', bom: false },
  { label: 'Korean (EUC-KR)', encoding: 'EUC-KR', bom: false },
];

async function openSettingsFile(scope: 'user' | 'workspace') {
  const { userPath } = useSettings.getState();
  const root = useWorkspace.getState().root;
  const path = scope === 'user' ? userPath : root ? join(root, '.lathe', 'settings.json') : null;
  if (!path) return;
  const exists = await backend().fs.stat(path);
  if (!exists) await backend().fs.writeText(path, '{\n  \n}\n', null, null, false);
  await openPath(path);
}

/** Runs a language command in the active editor, or says why it can't. */
function withServer(run: (view: EditorView) => unknown): () => void {
  return () => {
    const view = getActiveView();
    if (!view) {
      notify('info', 'Open a file first.');
      return;
    }
    if (!LSPPlugin.get(view)) {
      notify('info', 'No language server is running for this file.');
      return;
    }
    void run(view);
    view.focus();
  };
}

/** The active editor's file, for commands about it. */
function activePath(): string | null {
  return getActiveDoc()?.path ?? null;
}

function withActiveFile(run: (path: string) => unknown): () => void {
  return () => {
    const path = activePath();
    if (!path) {
      notify('info', 'Open a file first.');
      return;
    }
    void run(path);
  };
}

function gitCommands(): Command[] {
  const git = 'Git';
  return [
    { id: 'git.commit', title: 'Commit', category: git, run: () => void gitCommit() },
    {
      id: 'git.commitAmend',
      title: 'Commit (amend)',
      category: git,
      run: () => void gitCommit({ amend: true }),
    },
    {
      id: 'git.openChanges',
      title: 'Open changes',
      category: git,
      run: withActiveFile((path) => {
        const file = statusOf(path);
        if (!file) return notify('info', 'This file has no changes.');
        openChange(file, file.worktree !== '.' || file.index === '?' ? 'changes' : 'staged');
      }),
    },
    {
      id: 'git.stageFile',
      title: 'Stage this file',
      category: git,
      run: withActiveFile((p) => gitStage([p])),
    },
    {
      id: 'git.unstageFile',
      title: 'Unstage this file',
      category: git,
      run: withActiveFile((p) => gitUnstage([p])),
    },
    {
      id: 'git.fileHistory',
      title: 'Show file history',
      category: git,
      run: withActiveFile(showFileHistory),
    },
    {
      id: 'git.localHistory',
      title: 'Compare with an earlier save (local history)',
      category: 'File',
      run: withActiveFile(showLocalHistory),
    },
    {
      id: 'git.toggleBlame',
      title: 'Toggle line blame',
      category: git,
      run: () => void updateSetting('git.blame.inline', !getSetting('git.blame.inline')),
    },
    {
      id: 'git.branch',
      title: 'Switch branch…',
      category: git,
      run: () => void showBranchPicker(),
    },
    {
      id: 'git.createBranch',
      title: 'Create branch…',
      category: git,
      run: () => void createBranch(),
    },
    {
      id: 'git.deleteBranch',
      title: 'Delete branch…',
      category: git,
      run: () => void pickBranchToDelete(),
    },
    { id: 'git.pull', title: 'Pull', category: git, run: () => void gitRemote('pull') },
    { id: 'git.push', title: 'Push', category: git, run: () => void gitRemote('push') },
    { id: 'git.fetch', title: 'Fetch', category: git, run: () => void gitRemote('fetch') },
    { id: 'git.sync', title: 'Sync', category: git, run: () => void gitRemote('sync') },
    { id: 'git.stash', title: 'Stash changes', category: git, run: () => void gitStash('push') },
    {
      id: 'git.stashPop',
      title: 'Apply and drop the last stash',
      category: git,
      run: () => void gitStash('pop'),
    },
    {
      id: 'git.init',
      title: 'Initialize repository',
      category: git,
      run: () => void initRepository(),
    },
    { id: 'git.refresh', title: 'Refresh', category: git, run: () => void refreshGit() },
    {
      id: 'git.showOutput',
      title: 'Show Git output',
      category: git,
      run: () => void showGitOutput(),
    },
  ].map((c) =>
    c.id === 'git.init' || c.id === 'git.localHistory' ? c : { ...c, when: 'gitRepo' },
  );
}

function languageCommands(): Command[] {
  const go = 'Go';
  return [
    {
      id: 'editor.action.revealDefinition',
      title: 'Go to definition',
      category: go,
      run: withServer(jumpToDefinition),
    },
    {
      id: 'editor.action.goToDeclaration',
      title: 'Go to declaration',
      category: go,
      run: withServer(jumpToDeclaration),
    },
    {
      id: 'editor.action.goToTypeDefinition',
      title: 'Go to type definition',
      category: go,
      run: withServer(jumpToTypeDefinition),
    },
    {
      id: 'editor.action.goToImplementation',
      title: 'Go to implementations',
      category: go,
      run: withServer(jumpToImplementation),
    },
    {
      id: 'editor.action.goToReferences',
      title: 'Find all references',
      category: go,
      run: withServer(findReferences),
    },
    {
      id: 'editor.action.rename',
      title: 'Rename symbol',
      category: 'Edit',
      run: withServer(renameSymbolAt),
    },
    {
      id: 'editor.action.quickFix',
      title: 'Quick fix…',
      category: 'Edit',
      run: withServer(showCodeActions),
    },
    {
      id: 'editor.action.formatDocument',
      title: 'Format document',
      category: 'Edit',
      run: withServer(formatDocument),
    },
    {
      id: 'editor.action.triggerParameterHints',
      title: 'Show parameter hints',
      category: 'Edit',
      run: withServer(showSignatureHelp),
    },
    {
      id: 'lsp.restart',
      title: 'Restart language server',
      category: 'Language',
      run: () => void restartActiveServer(),
    },
    {
      id: 'lsp.stop',
      title: 'Stop language server',
      category: 'Language',
      run: () => void stopActiveServer(),
    },
    {
      id: 'lsp.showOutput',
      title: 'Show language server output',
      category: 'Language',
      run: showActiveServerOutput,
    },
    {
      id: 'lsp.install',
      title: 'Install a language server…',
      category: 'Language',
      run: () => void pickServerToInstall(),
    },
  ];
}

/** The active editor's selection, if it's on one line (it seeds the search box). */
function selectedText(): string | undefined {
  const view = getActiveView();
  if (!view) return undefined;
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  return text && !text.includes('\n') ? text : undefined;
}

export function registerWorkbenchCommands() {
  registerDebugCommands();
  registerNotebookCommands();
  registerPluginCommands();
  const commands: Command[] = [
    // ── Files ─────────────────────────────────────────────────────────────────────────────
    { id: 'file.new', title: 'New file', category: 'File', run: () => newUntitled() },
    {
      id: 'file.openFile',
      title: 'Open file…',
      category: 'File',
      run: async () => {
        for (const path of await backend().dialogs.pickFiles()) await openPath(path);
      },
    },
    { id: 'file.openFolder', title: 'Open folder…', category: 'File', run: pickAndOpenFolder },
    {
      id: 'workspace.open',
      title: 'Open folder',
      hidden: true,
      run: (path: never) => openFolder(path as unknown as string),
    },
    {
      id: 'file.closeFolder',
      title: 'Close folder',
      category: 'File',
      when: 'hasFolder',
      run: closeFolder,
    },
    {
      id: 'file.save',
      title: 'Save',
      category: 'File',
      run: () => {
        const { doc } = activeTab();
        if (doc) void saveDocument(doc);
      },
    },
    {
      id: 'file.saveAs',
      title: 'Save as…',
      category: 'File',
      run: () => {
        const { doc } = activeTab();
        if (doc) void saveDocument(doc, { as: true });
      },
    },
    {
      id: 'file.saveAll',
      title: 'Save all',
      category: 'File',
      run: async () => {
        for (const doc of dirtyDocuments()) await saveDocument(doc);
      },
    },
    {
      id: 'file.revert',
      title: 'Revert file',
      category: 'File',
      run: () => {
        const { doc } = activeTab();
        if (doc) void reloadDocument(doc);
      },
    },

    // ── Editors ───────────────────────────────────────────────────────────────────────────
    {
      id: 'editor.close',
      title: 'Close editor',
      category: 'View',
      run: () => {
        const { group, tab } = activeTab();
        if (tab) void closeTab(group.id, tab.id);
      },
    },
    { id: 'editor.closeAll', title: 'Close all editors', category: 'View', run: closeAllEditors },
    {
      id: 'editor.reopenClosed',
      title: 'Reopen closed editor',
      category: 'View',
      run: reopenClosed,
    },
    { id: 'editor.next', title: 'Next editor', category: 'View', run: () => cycleTab(1) },
    { id: 'editor.previous', title: 'Previous editor', category: 'View', run: () => cycleTab(-1) },
    {
      id: 'editor.nextRecent',
      title: 'Previous editor in use',
      category: 'View',
      hidden: true,
      run: () => cycleTab(1, false),
    },
    {
      id: 'editor.previousRecent',
      title: 'Next editor in use',
      category: 'View',
      hidden: true,
      run: () => cycleTab(-1, false),
    },
    {
      id: 'view.splitRight',
      title: 'Split editor right',
      category: 'View',
      run: () => void splitGroup('right'),
    },
    {
      id: 'view.splitDown',
      title: 'Split editor down',
      category: 'View',
      run: () => void splitGroup('down'),
    },
    ...[1, 2, 3].map((n) => ({
      id: `view.focusGroup${n}`,
      title: `Focus editor group ${n}`,
      category: 'View',
      run: () => focusGroupAt(n - 1),
    })),

    // ── Quick input ───────────────────────────────────────────────────────────────────────
    { id: 'quickOpen.files', title: 'Go to file…', category: 'Go', run: () => openQuickOpen('') },
    {
      id: 'quickOpen.commands',
      title: 'Show all commands',
      category: 'View',
      run: () => openQuickOpen('>'),
    },
    {
      id: 'quickOpen.goToLine',
      title: 'Go to line…',
      category: 'Go',
      run: () => openQuickOpen(':'),
    },
    {
      id: 'quickOpen.symbols',
      title: 'Go to symbol in editor',
      category: 'Go',
      run: () => openQuickOpen('@'),
    },
    {
      id: 'quickOpen.workspaceSymbols',
      title: 'Go to symbol in folder',
      category: 'Go',
      run: () => openQuickOpen('#'),
    },

    // ── Views and layout ──────────────────────────────────────────────────────────────────
    {
      id: 'view.explorer',
      title: 'Show explorer',
      category: 'View',
      run: () => showView('explorer'),
    },
    {
      id: 'view.search',
      title: 'Find in files',
      category: 'Search',
      run: () => {
        showView('search');
        focusSearch({ seed: selectedText() });
      },
    },
    {
      id: 'search.replace',
      title: 'Replace in files',
      category: 'Search',
      run: () => {
        showView('search');
        focusSearch({ replace: true, seed: selectedText() });
      },
    },
    {
      id: 'search.next',
      title: 'Go to next search result',
      category: 'Search',
      run: () => goToMatch(1),
    },
    {
      id: 'search.previous',
      title: 'Go to previous search result',
      category: 'Search',
      run: () => goToMatch(-1),
    },
    {
      id: 'search.clear',
      title: 'Clear search results',
      category: 'Search',
      run: () => clearSearch(),
    },
    { id: 'nav.back', title: 'Go back', category: 'Go', run: () => void goBack() },
    ...gitCommands(),
    ...languageCommands(),
    { id: 'nav.forward', title: 'Go forward', category: 'Go', run: () => void goForward() },
    { id: 'view.scm', title: 'Show source control', category: 'View', run: () => showView('scm') },
    {
      id: 'view.debug',
      title: 'Show run and debug',
      category: 'View',
      run: () => showView('debug'),
    },
    { id: 'view.plugins', title: 'Show plugins', category: 'View', run: () => showView('plugins') },
    { id: 'view.toggleSidebar', title: 'Toggle sidebar', category: 'View', run: toggleSidebar },
    { id: 'view.togglePanel', title: 'Toggle panel', category: 'View', run: togglePanel },
    {
      id: 'view.problems',
      title: 'Show problems',
      category: 'View',
      run: () => showPanel('problems', true),
    },
    {
      id: 'view.output',
      title: 'Show output',
      category: 'View',
      run: () => showPanel('output', true),
    },
    {
      id: 'view.toggleTerminal',
      title: 'Toggle terminal',
      category: 'View',
      run: () => void toggleTerminal(),
    },
    {
      id: 'terminal.new',
      title: 'Create new terminal',
      category: 'Terminal',
      run: () => void newTerminal(),
    },
    { id: 'view.toggleZen', title: 'Toggle zen mode', category: 'View', run: toggleZen },
    {
      id: 'view.exitZen',
      title: 'Leave zen mode',
      category: 'View',
      when: 'zen',
      hidden: true,
      run: () => useLayout.setState({ zen: false }),
    },
    {
      id: 'view.toggleWordWrap',
      title: 'Toggle word wrap',
      category: 'View',
      run: () =>
        void updateSetting(
          'editor.wordWrap',
          getSetting('editor.wordWrap') === 'on' ? 'off' : 'on',
        ),
    },
    {
      id: 'view.toggleMinimap',
      title: 'Toggle minimap',
      category: 'View',
      run: () =>
        void updateSetting('editor.minimap.enabled', !getSetting('editor.minimap.enabled')),
    },

    // ── Editing ───────────────────────────────────────────────────────────────────────────
    { id: 'edit.undo', title: 'Undo', category: 'Edit', run: inEditor(undo) },
    { id: 'edit.redo', title: 'Redo', category: 'Edit', run: inEditor(redo) },
    { id: 'edit.selectAll', title: 'Select all', category: 'Edit', run: inEditor(selectAll) },
    { id: 'edit.find', title: 'Find', category: 'Edit', run: inEditor(openFind) },
    { id: 'edit.replace', title: 'Replace', category: 'Edit', run: inEditor(openReplace) },
    {
      id: 'editor.toggleComment',
      title: 'Toggle line comment',
      category: 'Edit',
      run: inEditor(toggleComment),
    },
    {
      id: 'editor.toggleBlockComment',
      title: 'Toggle block comment',
      category: 'Edit',
      run: inEditor(toggleBlockComment),
    },
    {
      id: 'editor.addLineComment',
      title: 'Add line comment',
      category: 'Edit',
      run: inEditor(lineComment),
    },
    {
      id: 'editor.removeLineComment',
      title: 'Remove line comment',
      category: 'Edit',
      run: inEditor(lineUncomment),
    },
    {
      id: 'editor.copyLineUp',
      title: 'Copy line up',
      category: 'Selection',
      run: inEditor(copyLineUp),
    },
    {
      id: 'editor.copyLineDown',
      title: 'Copy line down',
      category: 'Selection',
      run: inEditor(copyLineDown),
    },
    {
      id: 'editor.moveLineUp',
      title: 'Move line up',
      category: 'Selection',
      run: inEditor(moveLineUp),
    },
    {
      id: 'editor.moveLineDown',
      title: 'Move line down',
      category: 'Selection',
      run: inEditor(moveLineDown),
    },
    {
      id: 'editor.addCursorAbove',
      title: 'Add cursor above',
      category: 'Selection',
      run: inEditor(addCursor(-1)),
    },
    {
      id: 'editor.addCursorBelow',
      title: 'Add cursor below',
      category: 'Selection',
      run: inEditor(addCursor(1)),
    },
    {
      id: 'editor.addNextOccurrence',
      title: 'Add next occurrence',
      category: 'Selection',
      run: inEditor(selectNextOccurrence),
    },
    {
      id: 'editor.selectAllOccurrences',
      title: 'Select all occurrences',
      category: 'Selection',
      run: inEditor(selectSelectionMatches),
    },
    {
      id: 'editor.expandSelection',
      title: 'Expand selection',
      category: 'Selection',
      run: inEditor(selectParentSyntax),
    },
    { id: 'editor.fold', title: 'Fold', category: 'Editor', run: inEditor(foldCode) },
    { id: 'editor.unfold', title: 'Unfold', category: 'Editor', run: inEditor(unfoldCode) },
    { id: 'editor.foldAll', title: 'Fold all', category: 'Editor', run: inEditor(foldAll) },
    { id: 'editor.unfoldAll', title: 'Unfold all', category: 'Editor', run: inEditor(unfoldAll) },
    {
      id: 'editor.changeLanguage',
      title: 'Change language mode',
      category: 'Editor',
      run: async () => {
        const { doc } = activeTab();
        if (!doc) return;
        const items = [
          { id: 'plaintext', label: 'Plain text' },
          ...[...LANGUAGES]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((l) => ({
              id: l.name,
              label: l.name,
              description: l.extensions
                .slice(0, 4)
                .map((e) => `.${e}`)
                .join(' '),
            })),
        ];
        const current = items.findIndex((i) => i.label === languageNameOf(doc.language));
        const picked = await quickPick(items, {
          placeholder: 'Select a language',
          active: Math.max(0, current),
        });
        if (!picked) return;
        doc.setLanguage(
          picked.id === 'plaintext' ? null : (LANGUAGES.find((l) => l.name === picked.id) ?? null),
        );
        for (const view of doc.views) {
          ensureLanguage(view, doc);
          reconfigureEditor(view, doc);
        }
      },
    },
    {
      id: 'editor.changeEol',
      title: 'Change end of line sequence',
      category: 'Editor',
      run: async () => {
        const { doc } = activeTab();
        if (!doc) return;
        const picked = await quickPick(
          [
            { id: 'lf', label: 'LF', description: 'Unix, macOS, most tools' },
            { id: 'crlf', label: 'CRLF', description: 'Windows' },
          ],
          { placeholder: 'Line endings for this file', active: doc.format.crlf ? 1 : 0 },
        );
        if (picked) doc.setFormat({ ...doc.format, crlf: picked.id === 'crlf' });
      },
    },
    {
      id: 'editor.changeEncoding',
      title: 'Save with encoding',
      category: 'Editor',
      run: async () => {
        const { doc } = activeTab();
        if (!doc) return;
        const current = ENCODINGS.findIndex(
          (e) =>
            e.encoding.toLowerCase() === doc.format.encoding.toLowerCase() &&
            e.bom === doc.format.bom,
        );
        const picked = await quickPick(
          ENCODINGS.map((e, i) => ({ id: String(i), label: e.label, description: e.encoding })),
          { placeholder: 'Save this file with encoding', active: Math.max(0, current) },
        );
        const choice = picked ? ENCODINGS[Number(picked.id)] : undefined;
        if (choice) doc.setFormat({ ...doc.format, encoding: choice.encoding, bom: choice.bom });
      },
    },
    {
      id: 'editor.changeIndentation',
      title: 'Change indentation',
      category: 'Editor',
      run: async () => {
        const { doc } = activeTab();
        if (!doc) return;
        const picked = await quickPick(
          [
            ...[2, 4, 8].map((n) => ({ id: `s${n}`, label: `Indent using spaces: ${n}` })),
            ...[2, 4, 8].map((n) => ({ id: `t${n}`, label: `Indent using tabs, tab size ${n}` })),
          ],
          { placeholder: 'Indentation for this file' },
        );
        if (!picked) return;
        doc.indent = { tabs: picked.id.startsWith('t'), size: Number(picked.id.slice(1)) };
        for (const view of doc.views) reconfigureEditor(view, doc);
      },
    },

    // ── Explorer ──────────────────────────────────────────────────────────────────────────
    {
      id: 'explorer.newFile',
      title: 'New file',
      category: 'Explorer',
      when: 'hasFolder',
      run: () => void startCreate(false),
    },
    {
      id: 'explorer.newFolder',
      title: 'New folder',
      category: 'Explorer',
      when: 'hasFolder',
      run: () => void startCreate(true),
    },
    {
      id: 'explorer.rename',
      title: 'Rename',
      category: 'Explorer',
      hidden: true,
      run: () => startRename(),
    },
    {
      id: 'explorer.delete',
      title: 'Delete',
      category: 'Explorer',
      hidden: true,
      run: () => void deleteSelected(),
    },
    {
      id: 'explorer.deletePermanently',
      title: 'Delete permanently',
      category: 'Explorer',
      hidden: true,
      run: () => void deleteSelected(true),
    },
    {
      id: 'explorer.copy',
      title: 'Copy',
      category: 'Explorer',
      hidden: true,
      run: () => copySelected(false),
    },
    {
      id: 'explorer.cut',
      title: 'Cut',
      category: 'Explorer',
      hidden: true,
      run: () => copySelected(true),
    },
    {
      id: 'explorer.paste',
      title: 'Paste',
      category: 'Explorer',
      hidden: true,
      run: () => void paste(),
    },
    {
      id: 'explorer.collapseAll',
      title: 'Collapse folders',
      category: 'Explorer',
      run: collapseAll,
    },
    {
      id: 'explorer.revealActiveFile',
      title: 'Reveal active file in explorer',
      category: 'Explorer',
      run: () => {
        showView('explorer');
        void revealActiveFile();
      },
    },

    // ── Preferences and help ──────────────────────────────────────────────────────────────
    {
      id: 'preferences.openSettings',
      title: 'Open settings',
      category: 'Preferences',
      run: () => showEditorTab('settings'),
    },
    {
      id: 'preferences.openSettingsJson',
      title: 'Open settings (JSON)',
      category: 'Preferences',
      run: () => void openSettingsFile('user'),
    },
    {
      id: 'preferences.openKeybindings',
      title: 'Open keyboard shortcuts',
      category: 'Preferences',
      run: () => showEditorTab('keybindings'),
    },
    {
      id: 'preferences.openKeybindingsJson',
      title: 'Open keyboard shortcuts (JSON)',
      category: 'Preferences',
      run: async () => openPath(await ensureKeybindingsFile()),
    },
    {
      id: 'preferences.openWorkspaceSettings',
      title: 'Open folder settings (JSON)',
      category: 'Preferences',
      when: 'hasFolder',
      run: () => void openSettingsFile('workspace'),
    },
    ...(['dark', 'light', 'system'] as const).map((theme) => ({
      id: `preferences.theme.${theme}`,
      title: theme === 'system' ? 'Theme: follow Windows' : `Theme: ${theme}`,
      category: 'Preferences',
      run: () => void updateSetting('workbench.theme', theme),
    })),
    {
      id: 'preferences.importFromVsCode',
      title: 'Import from VS Code',
      category: 'Preferences',
      run: () => importFromVsCode(),
    },
    {
      id: 'preferences.configureSnippets',
      title: 'Configure snippets',
      category: 'Preferences',
      run: async () => {
        const items = [
          { id: '*', label: 'For every language', description: 'global.code-snippets' },
          ...[...LANGUAGES]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((l) => ({
              id: languageIdOf(l),
              label: l.name,
              description: `${languageIdOf(l)}.json`,
            })),
        ];
        const picked = await quickPick(items, { placeholder: 'Snippets for which language?' });
        if (picked) await openPath(await snippetsFileFor(picked.id));
      },
    },
    {
      id: 'help.keyboardShortcuts',
      title: 'Keyboard shortcuts',
      category: 'Help',
      run: () => showEditorTab('keybindings'),
    },
    {
      id: 'help.welcome',
      title: 'Welcome',
      category: 'Help',
      run: () => showEditorTab('welcome'),
    },
    {
      id: 'markdown.showPreview',
      title: 'Open preview',
      category: 'Markdown',
      when: "editorLangId == 'markdown'",
      run: () => {
        const doc = getActiveDoc();
        if (doc) openPreview(doc, false);
      },
    },
    {
      id: 'markdown.showPreviewToSide',
      title: 'Open preview to the side',
      category: 'Markdown',
      when: "editorLangId == 'markdown'",
      run: () => {
        const doc = getActiveDoc();
        if (doc) openPreview(doc, true);
      },
    },
    {
      id: 'developer.startupPerformance',
      title: 'Startup performance',
      category: 'Developer',
      run: () => void showStartupReport(),
    },
    {
      id: 'help.about',
      title: 'About Lathe',
      category: 'Help',
      run: async () => {
        const info = await backend().systemInfo();
        notify('info', `Lathe ${info.appVersion}`, {
          detail: `WebView2 ${info.webviewVersion || 'unknown'} · data in ${info.dataDir}`,
        });
      },
    },
    { id: 'window.close', title: 'Exit', category: 'File', run: () => backend().window.close() },
    { id: 'run.file', title: 'Run file', category: 'Run', run: () => void runActiveFile() },
    { id: 'tasks.run', title: 'Run task…', category: 'Tasks', run: () => void runTaskCommand() },
    {
      id: 'tasks.build',
      title: 'Run build task',
      category: 'Tasks',
      run: () => void runGroupTask('build'),
    },
    {
      id: 'tasks.test',
      title: 'Run test task',
      category: 'Tasks',
      run: () => void runGroupTask('test'),
    },
    {
      id: 'tasks.rerun',
      title: 'Rerun last task',
      category: 'Tasks',
      run: () => void rerunLastTask(),
    },
    {
      id: 'tasks.configure',
      title: 'Configure tasks',
      category: 'Tasks',
      run: () => void configureTasks(),
    },
    {
      id: 'documents.list',
      title: 'Show open documents',
      hidden: true,
      run: () => allDocuments().map((d) => d.name),
    },
  ];
  registerCommands(commands);
}

const notTyping = '!inputFocus';

export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  ...DEBUG_KEYBINDINGS,
  { key: 'ctrl+n', command: 'file.new' },
  { key: 'ctrl+o', command: 'file.openFile' },
  { key: 'ctrl+k ctrl+o', command: 'file.openFolder' },
  { key: 'ctrl+k f', command: 'file.closeFolder' },
  { key: 'ctrl+s', command: 'file.save' },
  { key: 'ctrl+shift+s', command: 'file.saveAs' },
  { key: 'ctrl+k s', command: 'file.saveAll' },
  { key: 'ctrl+w', command: 'editor.close' },
  { key: 'ctrl+f4', command: 'editor.close' },
  { key: 'ctrl+k ctrl+w', command: 'editor.closeAll' },
  { key: 'ctrl+shift+t', command: 'editor.reopenClosed' },
  { key: 'ctrl+pagedown', command: 'editor.next' },
  { key: 'ctrl+pageup', command: 'editor.previous' },
  { key: 'ctrl+tab', command: 'editor.nextRecent' },
  { key: 'ctrl+shift+tab', command: 'editor.previousRecent' },
  { key: 'ctrl+\\', command: 'view.splitRight' },
  { key: 'ctrl+1', command: 'view.focusGroup1' },
  { key: 'ctrl+2', command: 'view.focusGroup2' },
  { key: 'ctrl+3', command: 'view.focusGroup3' },
  { key: 'ctrl+p', command: 'quickOpen.files' },
  { key: 'ctrl+e', command: 'quickOpen.files' },
  { key: 'ctrl+shift+p', command: 'quickOpen.commands' },
  { key: 'f1', command: 'quickOpen.commands' },
  { key: 'ctrl+g', command: 'quickOpen.goToLine' },
  { key: 'ctrl+b', command: 'view.toggleSidebar' },
  { key: 'ctrl+j', command: 'view.togglePanel' },
  { key: 'ctrl+shift+e', command: 'view.explorer' },
  { key: 'ctrl+shift+f', command: 'view.search' },
  { key: 'ctrl+shift+o', command: 'quickOpen.symbols' },
  { key: 'ctrl+t', command: 'quickOpen.workspaceSymbols' },
  { key: 'ctrl+shift+h', command: 'search.replace' },
  { key: 'f4', command: 'search.next' },
  { key: 'shift+f4', command: 'search.previous' },
  { key: 'alt+left', command: 'nav.back' },
  { key: 'f12', command: 'editor.action.revealDefinition', when: 'editorTextFocus' },
  { key: 'ctrl+f12', command: 'editor.action.goToImplementation', when: 'editorTextFocus' },
  { key: 'shift+f12', command: 'editor.action.goToReferences', when: 'editorTextFocus' },
  { key: 'f2', command: 'editor.action.rename', when: 'editorTextFocus' },
  { key: 'ctrl+.', command: 'editor.action.quickFix', when: 'editorTextFocus' },
  { key: 'shift+alt+f', command: 'editor.action.formatDocument', when: 'editorTextFocus' },
  {
    key: 'ctrl+shift+space',
    command: 'editor.action.triggerParameterHints',
    when: 'editorTextFocus',
  },
  { key: 'alt+right', command: 'nav.forward' },
  { key: 'ctrl+shift+g', command: 'view.scm' },
  { key: 'ctrl+shift+d', command: 'view.debug' },
  { key: 'ctrl+shift+x', command: 'view.plugins' },
  { key: 'ctrl+shift+m', command: 'view.problems' },
  { key: 'ctrl+shift+u', command: 'view.output' },
  { key: 'ctrl+`', command: 'view.toggleTerminal' },
  { key: 'ctrl+shift+`', command: 'terminal.new' },
  { key: 'ctrl+f5', command: 'run.file' },
  { key: 'ctrl+shift+b', command: 'tasks.build' },
  { key: 'ctrl+k z', command: 'view.toggleZen' },
  { key: 'escape escape', command: 'view.exitZen', when: 'zen' },
  { key: 'alt+z', command: 'view.toggleWordWrap' },
  { key: 'ctrl+,', command: 'preferences.openSettings' },
  { key: 'ctrl+k ctrl+s', command: 'preferences.openKeybindings' },
  {
    key: 'ctrl+shift+v',
    command: 'markdown.showPreview',
    when: "editorLangId == 'markdown' && !inputFocus",
  },
  {
    key: 'ctrl+k v',
    command: 'markdown.showPreviewToSide',
    when: "editorLangId == 'markdown' && !inputFocus",
  },
  { key: 'ctrl+k m', command: 'editor.changeLanguage' },
  { key: 'ctrl+k ctrl+c', command: 'editor.addLineComment', when: 'editorFocus' },
  { key: 'ctrl+k ctrl+u', command: 'editor.removeLineComment', when: 'editorFocus' },
  { key: 'ctrl+k ctrl+0', command: 'editor.foldAll', when: 'editorFocus' },
  { key: 'ctrl+k ctrl+j', command: 'editor.unfoldAll', when: 'editorFocus' },
  { key: 'ctrl+shift+[', command: 'editor.fold', when: 'editorFocus' },
  { key: 'ctrl+shift+]', command: 'editor.unfold', when: 'editorFocus' },
  { key: 'f2', command: 'explorer.rename', when: `explorerFocus && ${notTyping}` },
  { key: 'delete', command: 'explorer.delete', when: `explorerFocus && ${notTyping}` },
  {
    key: 'shift+delete',
    command: 'explorer.deletePermanently',
    when: `explorerFocus && ${notTyping}`,
  },
  { key: 'ctrl+c', command: 'explorer.copy', when: `explorerFocus && ${notTyping}` },
  { key: 'ctrl+x', command: 'explorer.cut', when: `explorerFocus && ${notTyping}` },
  { key: 'ctrl+v', command: 'explorer.paste', when: `explorerFocus && ${notTyping}` },
];
