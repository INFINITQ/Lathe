// Lathe's language features on top of @codemirror/lsp-client: quick fixes (Ctrl+.), rename
// across files (F2), inlay hints, highlights of the symbol under the cursor, Ctrl+click to go
// to a definition, formatting on save, and Mono styling for the client's tooltips and panels.

import { LSPPlugin, jumpToDefinition } from '@codemirror/lsp-client';
import { indentUnit } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type * as lsp from 'vscode-languageserver-protocol';
import { addSaveParticipant } from '../editor/documents';
import { errorMessage } from '../lib/backend';
import { notify } from '../services/notifications';
import { getSetting } from '../services/settings';
import { quickInputText, quickPick } from '../workbench/quickinput/store';
import { applyWorkspaceEdit } from './edits';
import { serverOfClient } from './server';

function overlaps(a: lsp.Range, b: lsp.Range): boolean {
  const before = (p: lsp.Position, q: lsp.Position) =>
    p.line < q.line || (p.line === q.line && p.character < q.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

function noServer() {
  notify('info', 'No language server is running for this file.');
}

/** Ctrl+.: the quick fixes and refactorings the server offers here. */
export async function showCodeActions(view: EditorView): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return noServer();
  const { client } = plugin;
  if (!client.serverCapabilities?.codeActionProvider) {
    notify('info', 'The language server has no quick fixes.');
    return;
  }
  client.sync();
  const { from, to } = view.state.selection.main;
  const range = { start: plugin.toPosition(from), end: plugin.toPosition(to) };
  const server = serverOfClient.get(client);
  const diagnostics = (server?.diagnostics.get(plugin.uri) ?? []).filter((d) =>
    overlaps(d.range, range),
  );
  let actions: (lsp.Command | lsp.CodeAction)[] | null;
  try {
    actions = await client.request('textDocument/codeAction', {
      textDocument: { uri: plugin.uri },
      range,
      context: { diagnostics, triggerKind: 1 },
    });
  } catch (err) {
    notify('error', "Couldn't get quick fixes.", { detail: errorMessage(err) });
    return;
  }
  const usable = (actions ?? []).filter((a) => !('disabled' in a && a.disabled));
  if (!usable.length) {
    notify('info', 'No quick fixes here.');
    return;
  }
  const preferred = (a: lsp.Command | lsp.CodeAction) =>
    'isPreferred' in a && a.isPreferred ? 0 : 1;
  usable.sort((a, b) => preferred(a) - preferred(b));
  const picked = await quickPick(
    usable.map((a, i) => ({
      id: String(i),
      label: a.title,
      description: 'kind' in a && a.kind ? a.kind : undefined,
      hint: preferred(a) === 0 ? 'Preferred' : undefined,
    })),
    { placeholder: 'Pick a quick fix or refactoring' },
  );
  if (!picked) return;
  const action = usable[Number(picked.id)]!;
  try {
    if (typeof action.command === 'string') {
      await client.request('workspace/executeCommand', {
        command: action.command,
        arguments: (action as lsp.Command).arguments,
      });
    } else {
      let resolved = action as lsp.CodeAction;
      const provider = client.serverCapabilities.codeActionProvider;
      if (!resolved.edit && typeof provider === 'object' && provider.resolveProvider) {
        resolved = await client.request('codeAction/resolve', resolved);
      }
      if (resolved.edit) {
        const result = await applyWorkspaceEdit(resolved.edit);
        if (!result.applied)
          notify('error', `Couldn't apply “${resolved.title}”.`, { detail: result.failure });
      }
      if (resolved.command) {
        await client.request('workspace/executeCommand', {
          command: resolved.command.command,
          arguments: resolved.command.arguments,
        });
      }
    }
  } catch (err) {
    notify('error', `Couldn't apply “${action.title}”.`, { detail: errorMessage(err) });
  }
  view.focus();
}

/** F2: renames the symbol under the cursor everywhere the server knows of. */
export async function renameSymbolAt(view: EditorView): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return noServer();
  const { client } = plugin;
  const provider = client.serverCapabilities?.renameProvider;
  if (!provider) {
    notify('info', "The language server can't rename things.");
    return;
  }
  client.sync();
  const pos = view.state.selection.main.head;
  const position = plugin.toPosition(pos);
  const word = view.state.wordAt(pos);
  let current = word ? view.state.sliceDoc(word.from, word.to) : '';
  if (typeof provider === 'object' && provider.prepareProvider) {
    try {
      const prepared = await client.request<
        lsp.PrepareRenameParams,
        lsp.PrepareRenameResult | null
      >('textDocument/prepareRename', { textDocument: { uri: plugin.uri }, position });
      if (!prepared) {
        notify('info', "That can't be renamed.");
        return;
      }
      if ('placeholder' in prepared) current = prepared.placeholder;
      else if ('start' in prepared) {
        const r = prepared as lsp.Range;
        current = view.state.sliceDoc(plugin.fromPosition(r.start), plugin.fromPosition(r.end));
      }
    } catch (err) {
      notify('info', errorMessage(err));
      return;
    }
  }
  if (!current) {
    notify('info', 'Put the cursor on a name to rename it.');
    return;
  }
  const newName = await quickInputText({
    placeholder: `New name for ${current}`,
    value: current,
    prompt: 'Press Enter to rename it everywhere, or Escape to cancel.',
  });
  if (!newName || newName === current) {
    view.focus();
    return;
  }
  try {
    const edit = await client.request<lsp.RenameParams, lsp.WorkspaceEdit | null>(
      'textDocument/rename',
      {
        textDocument: { uri: plugin.uri },
        position,
        newName,
      },
    );
    if (!edit) {
      notify('info', 'Nothing to rename.');
      return;
    }
    const result = await applyWorkspaceEdit(edit);
    if (!result.applied) notify('error', `Couldn't rename ${current}.`, { detail: result.failure });
    else if (result.files > 1)
      notify('info', `Renamed ${current} to ${newName} in ${result.files} files.`);
  } catch (err) {
    notify('error', `Couldn't rename ${current}.`, { detail: errorMessage(err) });
  }
  view.focus();
}

// Inlay hints: the server's type and parameter-name hints, for the visible part of the file.

const setHints = StateEffect.define<DecorationSet>();

const hintField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) if (effect.is(setHints)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class HintWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: HintWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-inlayHint';
    span.textContent = this.label;
    return span;
  }
}

const inlayHints = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    version = 0;
    constructor(readonly view: EditorView) {
      this.schedule(300);
      window.addEventListener('lathe:inlay-refresh', this.refresh);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.schedule(update.docChanged ? 600 : 150);
    }
    refresh = () => this.schedule(0);
    schedule(delay: number) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.fetch(), delay);
    }
    async fetch() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin || !plugin.client.serverCapabilities?.inlayHintProvider) return;
      if (!getSetting('editor.inlayHints.enabled')) {
        this.view.dispatch({ effects: setHints.of(Decoration.none) });
        return;
      }
      plugin.client.sync();
      const version = ++this.version;
      const doc = this.view.state.doc;
      const { from, to } = this.view.viewport;
      const hints = await plugin.client
        .request<lsp.InlayHintParams, lsp.InlayHint[] | null>('textDocument/inlayHint', {
          textDocument: { uri: plugin.uri },
          range: { start: plugin.toPosition(from, doc), end: plugin.toPosition(to, doc) },
        })
        .catch(() => null);
      if (version !== this.version || !hints || this.view.state.doc !== doc) return;
      const decorations = hints
        .map((hint) => {
          const label =
            typeof hint.label === 'string' ? hint.label : hint.label.map((p) => p.value).join('');
          const text = `${hint.paddingLeft ? ' ' : ''}${label}${hint.paddingRight ? ' ' : ''}`;
          return Decoration.widget({ widget: new HintWidget(text), side: 1 }).range(
            plugin.fromPosition(hint.position, doc),
          );
        })
        .sort((a, b) => a.from - b.from);
      this.view.dispatch({ effects: setHints.of(Decoration.set(decorations, true)) });
    }
    destroy() {
      clearTimeout(this.timer);
      window.removeEventListener('lathe:inlay-refresh', this.refresh);
    }
  },
);

// Highlights of the symbol under the cursor (the server's, so only real references light up).

const setHighlights = StateEffect.define<DecorationSet>();
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? Decoration.none : value;
    for (const effect of tr.effects) if (effect.is(setHighlights)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const readMark = Decoration.mark({ class: 'cm-lspHighlight' });
const writeMark = Decoration.mark({ class: 'cm-lspHighlight cm-lspHighlight-write' });

const documentHighlights = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    version = 0;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      if (!update.selectionSet && !update.docChanged) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.fetch(), 250);
    }
    async fetch() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin?.client.serverCapabilities?.documentHighlightProvider) return;
      const { state } = this.view;
      const head = state.selection.main;
      if (!head.empty || !state.wordAt(head.head)) {
        this.view.dispatch({ effects: setHighlights.of(Decoration.none) });
        return;
      }
      plugin.client.sync();
      const version = ++this.version;
      const doc = state.doc;
      const found = await plugin.client
        .request<lsp.DocumentHighlightParams, lsp.DocumentHighlight[] | null>(
          'textDocument/documentHighlight',
          {
            textDocument: { uri: plugin.uri },
            position: plugin.toPosition(head.head, doc),
          },
        )
        .catch(() => null);
      if (version !== this.version || this.view.state.doc !== doc) return;
      const ranges = (found ?? [])
        .map((h) => {
          const from = plugin.fromPosition(h.range.start, doc);
          const to = plugin.fromPosition(h.range.end, doc);
          return to > from ? (h.kind === 3 ? writeMark : readMark).range(from, to) : null;
        })
        .filter((r) => r !== null)
        .sort((a, b) => a.from - b.from);
      this.view.dispatch({ effects: setHighlights.of(Decoration.set(ranges, true)) });
    }
    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** Ctrl+click: go to the definition of what's under the pointer. */
const ctrlClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!event.ctrlKey || event.button !== 0 || event.altKey || event.shiftKey) return false;
    if (!LSPPlugin.get(view)?.client.serverCapabilities?.definitionProvider) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    event.preventDefault();
    view.dispatch({ selection: { anchor: pos } });
    jumpToDefinition(view);
    return true;
  },
});

const theme = EditorView.baseTheme({
  '.cm-inlayHint': {
    color: 'var(--text-3)',
    backgroundColor: 'var(--hover)',
    borderRadius: '3px',
    padding: '0 3px',
    margin: '0 1px',
    fontSize: '0.9em',
    fontStyle: 'normal',
  },
  '.cm-lspHighlight': { backgroundColor: 'var(--accent-soft)' },
  '.cm-lspHighlight-write': { outline: '1px solid var(--line-strong)' },
  '.cm-lsp-documentation, .cm-lsp-signature-tooltip': {
    padding: '6px 9px',
    maxWidth: '560px',
    maxHeight: '320px',
    overflow: 'auto',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    lineHeight: '1.5',
    color: 'var(--text)',
  },
  '.cm-lsp-documentation pre, .cm-lsp-documentation code': {
    fontFamily: 'var(--font-code)',
    fontSize: '12px',
  },
  '.cm-lsp-documentation pre': {
    margin: '4px 0',
    padding: '6px 8px',
    borderRadius: '4px',
    backgroundColor: 'var(--bg)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-lsp-documentation p': { margin: '4px 0' },
  '.cm-lsp-documentation a': { color: 'var(--accent-fg)' },
  '.cm-lsp-active-parameter': { color: 'var(--accent-fg)', fontWeight: '600' },
  '.cm-lsp-reference-panel': {
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    backgroundColor: 'var(--bg-raised)',
    borderTop: '1px solid var(--line)',
    maxHeight: '220px',
    overflow: 'auto',
  },
  '.cm-lsp-reference-file': { color: 'var(--text-2)', fontWeight: '500', padding: '3px 10px' },
  '.cm-lsp-reference': {
    padding: '1px 10px 1px 24px',
    fontFamily: 'var(--font-code)',
    cursor: 'pointer',
  },
  '.cm-lsp-reference[aria-selected]': { backgroundColor: 'var(--active)' },
  '.cm-lsp-reference-line': { color: 'var(--text-3)', marginRight: '8px' },
});

/** Everything above, for an editor attached to a language server. */
export const latheLspFeatures = [
  hintField,
  inlayHints,
  highlightField,
  documentHighlights,
  ctrlClick,
  theme,
];

/** Formatting on save, when editor.formatOnSave is on and the server can format. */
addSaveParticipant(async (doc) => {
  if (!getSetting('editor.formatOnSave', doc.languageId)) return;
  const view = [...doc.views].find((v) => LSPPlugin.get(v));
  const plugin = view && LSPPlugin.get(view);
  if (!view || !plugin?.client.serverCapabilities?.documentFormattingProvider) return;
  plugin.client.sync();
  const before = view.state.doc;
  const edits = await Promise.race([
    plugin.client.request<lsp.DocumentFormattingParams, lsp.TextEdit[] | null>(
      'textDocument/formatting',
      {
        textDocument: { uri: plugin.uri },
        options: {
          tabSize: view.state.tabSize,
          insertSpaces: !view.state.facet(indentUnit).includes('\t'),
        },
      },
    ),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), getSetting('editor.formatOnSaveTimeout')),
    ),
  ]);
  if (!edits?.length || view.state.doc !== before) return;
  view.dispatch({
    changes: edits.map((e) => ({
      from: plugin.fromPosition(e.range.start),
      to: plugin.fromPosition(e.range.end),
      insert: e.newText,
    })),
    userEvent: 'format',
  });
});
