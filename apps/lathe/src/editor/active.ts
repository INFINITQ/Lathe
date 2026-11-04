// The editor you're working in: commands act on it and the status bar describes it.

import type { EditorView } from '@codemirror/view';
import { create } from 'zustand';
import { setContext } from '../services/context';
import type { TextDoc } from './documents';

export interface EditorStatus {
  docId: string | null;
  line: number;
  column: number;
  /** Number of cursors / selections. */
  selections: number;
  /** Characters selected (all selections together). */
  selected: number;
}

export const useEditorStatus = create<EditorStatus>(() => ({
  docId: null,
  line: 1,
  column: 1,
  selections: 1,
  selected: 0,
}));

let activeView: EditorView | null = null;
let activeDoc: TextDoc | null = null;
const listeners = new Set<(view: EditorView | null) => void>();

export function setActiveEditor(view: EditorView | null, doc: TextDoc | null) {
  const changed = view !== activeView;
  activeView = view;
  activeDoc = doc;
  // For "when" clauses: the language of the editor you last worked in.
  setContext('editorLangId', doc?.languageId ?? '');
  if (view) updateStatus(view, doc);
  else useEditorStatus.setState({ docId: null });
  if (changed) listeners.forEach((listener) => listener(view));
}

/** Calls `listener` whenever a different editor becomes the active one. */
export function onActiveEditorChange(listener: (view: EditorView | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getActiveView(): EditorView | null {
  return activeView && activeView.dom.isConnected ? activeView : null;
}

export function getActiveDoc(): TextDoc | null {
  return activeDoc;
}

/** Refreshes the status bar from an editor's selection. */
export function updateStatus(view: EditorView, doc: TextDoc | null) {
  if (view !== activeView) return;
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  // Columns count tabs as the tab size, as VS Code does.
  const tabSize = state.tabSize;
  let column = 1;
  for (const ch of line.text.slice(0, head - line.from)) {
    column += ch === '\t' ? tabSize - ((column - 1) % tabSize) : 1;
  }
  useEditorStatus.setState({
    docId: doc?.id ?? null,
    line: line.number,
    column,
    selections: state.selection.ranges.length,
    selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0),
  });
}
