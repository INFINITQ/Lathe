// The active editor's symbols and cursor, kept current for the outline view and the
// breadcrumbs: recomputed a moment after typing stops, when parsing catches up, and when
// another editor becomes active.

import { syntaxTree } from '@codemirror/language';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { create } from 'zustand';
import { getActiveView, onActiveEditorChange } from './active';
import { type DocSymbol, documentSymbols } from './symbols';

interface OutlineState {
  view: EditorView | null;
  symbols: DocSymbol[];
  cursor: number;
}

export const useOutline = create<OutlineState>(() => ({ view: null, symbols: [], cursor: 0 }));

function compute(view: EditorView | null) {
  if (!view) {
    useOutline.setState({ view: null, symbols: [], cursor: 0 });
    return;
  }
  useOutline.setState({
    view,
    symbols: documentSymbols(view.state),
    cursor: view.state.selection.main.head,
  });
}

onActiveEditorChange((view) => compute(view));

/** Watches one editor; only the active editor's changes reach the store. */
export const outlineTracker = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (getActiveView() !== this.view) return;
      if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (getActiveView() === this.view) compute(this.view);
        }, 250);
      }
      if (update.selectionSet) useOutline.setState({ cursor: update.state.selection.main.head });
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

/** Puts the cursor on a symbol's name and scrolls it into the middle of the editor. */
export function revealSymbol(view: EditorView, symbol: DocSymbol, focus = true) {
  view.dispatch({
    selection: { anchor: symbol.nameFrom, head: symbol.nameTo },
    effects: EditorView.scrollIntoView(symbol.nameFrom, { y: 'center' }),
  });
  if (focus) view.focus();
}
