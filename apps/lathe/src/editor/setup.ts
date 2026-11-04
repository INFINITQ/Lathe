// The extensions every text editor gets, driven by settings. Settings live in compartments, so
// changing one reconfigures the open editors in place.

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
} from '@codemirror/view';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { getSetting } from '../services/settings';
import { type TextDoc, allDocuments, syncAnnotation } from './documents';
import { findKeymap, findWidget } from './find';
import { altClickAddsCursor, latheEditorKeymap } from './keymap';
import { minimap } from './minimap';
import { navigationTracker } from '../services/navigation';
import { inlineBlame } from './blame';
import { mergeConflicts } from './conflicts';
import { gitGutter } from './gitGutter';
import { outlineTracker } from './outline';
import { stickyScroll } from './stickyScroll';
import { latheTheme } from './theme';
import { notify } from '../services/notifications';

const LARGE_CHARS = 2_000_000;
const LARGE_LINES = 50_000;

/** A file big enough that the extras which look at all of it, or draw something for every line,
 * are left out (the minimap, sticky scroll, guides, folding, whitespace marks, Git bars, blame
 * and the language server). Typing, highlighting and search stay. */
export function isLargeDoc(doc: TextDoc): boolean {
  return (
    getSetting('editor.largeFileOptimizations') &&
    (doc.text.length > LARGE_CHARS || doc.text.lines > LARGE_LINES)
  );
}

const toldLarge = new WeakSet<TextDoc>();
const large = isLargeDoc;

/** One compartment per setting-driven part, shared by every editor. */
export const compartments = {
  language: new Compartment(),
  indent: new Compartment(),
  wrap: new Compartment(),
  lineNumbers: new Compartment(),
  whitespace: new Compartment(),
  activeLine: new Compartment(),
  guides: new Compartment(),
  brackets: new Compartment(),
  folding: new Compartment(),
  scrollPastEnd: new Compartment(),
  readOnly: new Compartment(),
  emmet: new Compartment(),
  minimap: new Compartment(),
  stickyScroll: new Compartment(),
  lsp: new Compartment(),
  git: new Compartment(),
  blame: new Compartment(),
  extra: new Compartment(),
  vim: new Compartment(),
};

/** Languages where Emmet abbreviations ("ul>li*3", "m10") expand with Tab, as in VS Code. */
const EMMET_LANGUAGES = new Set([
  'html',
  'xml',
  'css',
  'scss',
  'sass',
  'less',
  'javascriptreact',
  'typescriptreact',
  'vue',
  'svelte',
]);

// Vim mode and Emmet are big, and many sessions never use them: each loads the first time an
// editor needs it, and the open editors take it up then.
let vimMode: Extension | null = null;
let vimLoading: Promise<void> | null = null;
let emmet: Extension | null = null;
let emmetLoading: Promise<void> | null = null;

function vimPart(): Extension {
  if (!getSetting('editor.vim')) return [];
  if (vimMode) return vimMode;
  vimLoading ??= import('./vimCommands')
    .then((m) => {
      vimMode = m.vimMode();
      for (const doc of allDocuments()) {
        for (const view of doc.views)
          view.dispatch({ effects: compartments.vim.reconfigure(vimPart()) });
      }
    })
    // Tried again the next time an editor needs it.
    .catch(() => {
      vimLoading = null;
    });
  return [];
}

function emmetPart(language: string): Extension {
  if (!getSetting('editor.emmet', language) || !EMMET_LANGUAGES.has(language)) return [];
  if (emmet) return emmet;
  emmetLoading ??= import('@emmetio/codemirror6-plugin')
    .then((m) => {
      emmet = m.abbreviationTracker();
      for (const doc of allDocuments()) {
        const part = emmetPart(doc.languageId);
        for (const view of doc.views)
          view.dispatch({ effects: compartments.emmet.reconfigure(part) });
      }
    })
    .catch(() => {
      emmetLoading = null;
    });
  return [];
}

/** The language server part of an editor (set by lsp/manager.ts, which loads after this). */
let lspProvider: (doc: TextDoc) => Extension = () => [];
export function setLspExtensionProvider(provider: (doc: TextDoc) => Extension) {
  lspProvider = provider;
}

/** The debugger part of an editor: breakpoints, the stopped line, hover values (debug/editor.ts). */
let debugProvider: (doc: TextDoc) => Extension = () => [];
export function setDebugExtensionProvider(provider: (doc: TextDoc) => Extension) {
  debugProvider = provider;
}

/** Per-document parts other modules add (# %% cells in Python files), set once at start-up. */
const documentProviders: ((doc: TextDoc) => Extension)[] = [];
export function addDocumentExtensions(provider: (doc: TextDoc) => Extension) {
  documentProviders.push(provider);
}

/** Extensions added by other modules (find widget, minimap, LSP…), set once at start-up. */
let extraExtensions: Extension[] = [];
export function addEditorExtensions(...extensions: Extension[]) {
  extraExtensions = [...extraExtensions, ...extensions];
}

function relativeLineNumbers(): Extension {
  return lineNumbers({
    formatNumber: (n, state) => {
      const current = state.doc.lineAt(state.selection.main.head).number;
      return n === current ? String(n) : String(Math.abs(current - n));
    },
  });
}

function indentFor(doc: TextDoc): Extension {
  const language = doc.languageId;
  const detect = getSetting('editor.detectIndentation', language);
  const detected = detect ? doc.indent : null;
  const tabs = detected ? detected.tabs : !getSetting('editor.insertSpaces', language);
  const size = detected?.size ?? getSetting('editor.tabSize', language);
  return [EditorState.tabSize.of(size), indentUnit.of(tabs ? '\t' : ' '.repeat(size))];
}

/** The parts of an editor that follow settings (also used to reconfigure). */
function settingParts(doc: TextDoc) {
  const language = doc.languageId;
  const numbers = getSetting('editor.lineNumbers', language);
  const whitespace = large(doc) ? 'none' : getSetting('editor.renderWhitespace', language);
  const on = (key: Parameters<typeof getSetting>[0]) =>
    !large(doc) && getSetting(key, language) === true;
  return {
    indent: indentFor(doc),
    wrap: getSetting('editor.wordWrap', language) === 'on' ? EditorView.lineWrapping : [],
    lineNumbers:
      numbers === 'off'
        ? []
        : [
            numbers === 'relative' ? relativeLineNumbers() : lineNumbers(),
            highlightActiveLineGutter(),
          ],
    whitespace:
      whitespace === 'all'
        ? highlightWhitespace()
        : whitespace === 'trailing'
          ? highlightTrailingWhitespace()
          : [],
    activeLine: getSetting('editor.renderLineHighlight', language) ? highlightActiveLine() : [],
    guides: on('editor.guides.indentation')
      ? indentationMarkers({
          thickness: 1,
          colors: {
            light: 'var(--line-strong)',
            dark: 'var(--line-strong)',
            activeLight: 'var(--text-4)',
            activeDark: 'var(--text-4)',
          },
        })
      : [],
    brackets: [
      getSetting('editor.matchBrackets', language) ? bracketMatching() : [],
      getSetting('editor.autoClosingBrackets', language) ? closeBrackets() : [],
    ],
    folding: on('editor.folding') ? foldGutter({ openText: '⌄', closedText: '›' }) : [],
    scrollPastEnd: getSetting('editor.scrollBeyondLastLine', language) ? scrollPastEnd() : [],
    readOnly: [EditorState.readOnly.of(doc.readOnly), EditorView.editable.of(!doc.readOnly)],
    stickyScroll: on('editor.stickyScroll.enabled') ? stickyScroll() : [],
    blame: doc.path && on('git.blame.inline') ? inlineBlame(doc.path) : [],
    minimap: on('editor.minimap.enabled') ? minimap() : [],
    vim: vimPart(),
    emmet: emmetPart(language),
  };
}

/** Keeps a document's other editors (and the document itself) in step with this one. */
function documentSync(doc: TextDoc, onEdit: () => void): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    doc.setText(update.state.doc);
    const fromSync = update.transactions.some((tr) => tr.annotation(syncAnnotation));
    if (fromSync) return;
    onEdit();
    for (const other of doc.views) {
      if (other === update.view) continue;
      other.dispatch({
        changes: update.changes,
        annotations: [syncAnnotation.of(true)],
      });
    }
  });
}

export interface EditorHooks {
  /** The first edit in a preview tab makes it a regular tab. */
  onEdit: () => void;
  onSelection: (view: EditorView) => void;
  onFocus: (view: EditorView) => void;
}

/** Every extension for an editor of `doc`. A diff editor leaves out the Git gutter (it marks
 * changes itself) and the debugger's gutter. */
export function editorExtensions(
  doc: TextDoc,
  hooks: EditorHooks,
  options: { diff?: boolean } = {},
): Extension[] {
  const parts = settingParts(doc);
  const lightweight = large(doc);
  if (lightweight && !toldLarge.has(doc)) {
    toldLarge.add(doc);
    notify(
      'info',
      `${doc.name} is large, so the minimap, guides, folding, Git bars and language server are off for it.`,
      { detail: 'Settings › Large files turns this off.' },
    );
  }
  return [
    // First, so the breakpoint gutter sits left of the line numbers.
    // Vim's keys go before every other keymap.
    compartments.vim.of(parts.vim),
    // (Per-document extras such as # %% cells scan the whole file, so a large one goes without.)
    options.diff
      ? []
      : [debugProvider(doc), lightweight ? [] : documentProviders.map((provide) => provide(doc))],
    compartments.lineNumbers.of(parts.lineNumbers),
    compartments.git.of(doc.path && !options.diff && !lightweight ? gitGutter(doc.path) : []),
    compartments.blame.of(parts.blame),
    mergeConflicts,
    compartments.folding.of(parts.folding),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    altClickAddsCursor,
    indentOnInput(),
    compartments.brackets.of(parts.brackets),
    autocompletion({ icons: false }),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
    crosshairCursor({ key: 'Alt' }),
    compartments.activeLine.of(parts.activeLine),
    highlightSelectionMatches(),
    findWidget(),
    Prec.high(keymap.of(findKeymap)),
    compartments.minimap.of(parts.minimap),
    compartments.stickyScroll.of(parts.stickyScroll),
    outlineTracker,
    navigationTracker,
    keymap.of([
      ...latheEditorKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    compartments.language.of(doc.language?.support ?? []),
    compartments.indent.of(parts.indent),
    compartments.wrap.of(parts.wrap),
    compartments.whitespace.of(parts.whitespace),
    compartments.guides.of(parts.guides),
    compartments.scrollPastEnd.of(parts.scrollPastEnd),
    compartments.readOnly.of(parts.readOnly),
    compartments.emmet.of(parts.emmet),
    compartments.extra.of(extraExtensions),
    compartments.lsp.of(lightweight ? [] : lspProvider(doc)),
    EditorView.contentAttributes.of({
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      'aria-label': `${doc.name} (editor)`,
    }),
    documentSync(doc, hooks.onEdit),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) hooks.onSelection(update.view);
      if (update.focusChanged && update.view.hasFocus) hooks.onFocus(update.view);
    }),
    latheTheme,
  ];
}

/** Loads the document's language (if it isn't yet) and puts it in the editor. */
export function ensureLanguage(view: EditorView, doc: TextDoc) {
  const language = doc.language;
  if (!language) {
    view.dispatch({ effects: compartments.language.reconfigure([]) });
    return;
  }
  if (language.support) {
    view.dispatch({ effects: compartments.language.reconfigure(language.support) });
    return;
  }
  void language.load().then((support) => {
    if (doc.language === language && view.dom.isConnected) {
      view.dispatch({ effects: compartments.language.reconfigure(support) });
    }
  });
}

/** Re-applies settings to an open editor (after a settings change). */
export function reconfigureEditor(view: EditorView, doc: TextDoc) {
  const parts = settingParts(doc);
  view.dispatch({
    effects: [
      compartments.indent.reconfigure(parts.indent),
      compartments.wrap.reconfigure(parts.wrap),
      compartments.lineNumbers.reconfigure(parts.lineNumbers),
      compartments.whitespace.reconfigure(parts.whitespace),
      compartments.activeLine.reconfigure(parts.activeLine),
      compartments.guides.reconfigure(parts.guides),
      compartments.brackets.reconfigure(parts.brackets),
      compartments.folding.reconfigure(parts.folding),
      compartments.scrollPastEnd.reconfigure(parts.scrollPastEnd),
      compartments.readOnly.reconfigure(parts.readOnly),
      compartments.emmet.reconfigure(parts.emmet),
      compartments.vim.reconfigure(parts.vim),
      compartments.minimap.reconfigure(parts.minimap),
      compartments.stickyScroll.reconfigure(parts.stickyScroll),
      compartments.blame.reconfigure(parts.blame),
    ],
  });
}
