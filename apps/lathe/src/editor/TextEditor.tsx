import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { focusGroup, keepTab, pendingSelections, useEditors } from '../workbench/editors/store';
import { getActiveView, setActiveEditor, updateStatus } from './active';
import { getDocument } from './documents';
import { editorExtensions, ensureLanguage, reconfigureEditor } from './setup';

interface SavedState {
  state: EditorState;
  /** The group the state was built for (its hooks point there); '' for seeded states. */
  groupId: string;
  top: number;
  left: number;
}

/** Each tab's editor while it isn't showing: undo history, selection and scroll position. */
const savedStates = new Map<string, SavedState>();

export function forgetTabState(tabId: string) {
  savedStates.delete(tabId);
}

/** Where a tab's cursor and scroll position are, for the session. */
export function tabViewState(tabId: string): { anchor: number; head: number; top: number } | null {
  const live = liveViews.get(tabId);
  if (live) {
    const { anchor, head } = live.state.selection.main;
    return { anchor, head, top: live.scrollDOM.scrollTop };
  }
  const saved = savedStates.get(tabId);
  if (!saved) return null;
  const { anchor, head } = saved.state.selection.main;
  return { anchor, head, top: saved.top };
}

/** Seeds a tab's cursor and scroll position before it first shows (session restore). */
export function seedTabViewState(
  tabId: string,
  docId: string,
  view: { anchor: number; head: number; top: number },
) {
  const doc = getDocument(docId);
  if (!doc) return;
  const clamp = (n: number) => Math.max(0, Math.min(n, doc.text.length));
  const state = EditorState.create({
    doc: doc.text,
    selection: EditorSelection.single(clamp(view.anchor), clamp(view.head)),
  });
  savedStates.set(tabId, { state, groupId: '', top: view.top, left: 0 });
}

/** Editors on screen, by tab id. */
const liveViews = new Map<string, EditorView>();

function applyPendingSelection(view: EditorView, docId: string) {
  const pending = pendingSelections.get(docId);
  if (!pending) return;
  pendingSelections.delete(docId);
  const { doc } = view.state;
  const at = (lineNo: number, column = 1) => {
    const line = doc.line(Math.max(1, Math.min(lineNo, doc.lines)));
    return Math.min(line.from + Math.max(0, column - 1), line.to);
  };
  const pos = at(pending.line, pending.column);
  const end = pending.endLine ? at(pending.endLine, pending.endColumn) : pos;
  view.dispatch({
    selection: EditorSelection.single(pos, end),
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  if (!pending.preserveFocus) view.focus();
}

/**
 * A text editor for one tab. CodeMirror is mounted outside React's render cycle: React owns
 * the host element, CodeMirror everything inside it, so typing never re-renders React.
 */
export function TextEditor({
  groupId,
  tabId,
  docId,
  focusOnMount,
}: {
  groupId: string;
  tabId: string;
  docId: string;
  focusOnMount: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const parent = host.current;
    const doc = getDocument(docId);
    if (!parent || !doc) return;
    const hooks = {
      onEdit: () => {
        const group = useEditors.getState().groups.find((g) => g.id === groupId);
        if (group?.tabs.some((t) => t.id === tabId && t.preview)) keepTab(groupId, tabId);
      },
      onSelection: (view: EditorView) => updateStatus(view, doc),
      onFocus: (view: EditorView) => {
        setActiveEditor(view, doc);
        focusGroup(groupId);
      },
    };
    const saved = savedStates.get(tabId);
    let state: EditorState;
    const reuse = saved && saved.groupId === groupId && saved.state.doc.eq(doc.text);
    if (reuse) {
      state = saved.state;
    } else {
      const length = doc.text.length;
      const selection = saved
        ? EditorSelection.single(
            Math.min(saved.state.selection.main.anchor, length),
            Math.min(saved.state.selection.main.head, length),
          )
        : undefined;
      state = EditorState.create({
        doc: doc.text,
        selection,
        extensions: editorExtensions(doc, hooks),
      });
    }
    const view = new EditorView({ state, parent });
    viewRef.current = view;
    liveViews.set(tabId, view);
    doc.views.add(view);
    // Settings may have changed while the tab was hidden.
    if (reuse) reconfigureEditor(view, doc);
    ensureLanguage(view, doc);
    if (saved) {
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = saved.top;
        view.scrollDOM.scrollLeft = saved.left;
      });
    }
    const { activeGroup } = useEditors.getState();
    if (activeGroup === groupId) setActiveEditor(view, doc);
    const keepFocus = pendingSelections.get(docId)?.preserveFocus ?? false;
    applyPendingSelection(view, docId);
    if (focusOnMount && !keepFocus && activeGroup === groupId) view.focus();
    return () => {
      savedStates.set(tabId, {
        state: view.state,
        groupId,
        top: view.scrollDOM.scrollTop,
        left: view.scrollDOM.scrollLeft,
      });
      liveViews.delete(tabId);
      doc.views.delete(view);
      if (getActiveView() === view) setActiveEditor(null, null);
      viewRef.current = null;
      view.destroy();
    };
    // focusOnMount only matters when the editor first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, docId, groupId]);

  // A file opened again "at line N" while this editor already shows it.
  useEditors((s) => s.selectionRequest);
  useEffect(() => {
    const view = viewRef.current;
    if (view) applyPendingSelection(view, docId);
  });

  return <div ref={host} className="editor-host" data-doc={docId} />;
}

/** Every editor on screen (settings changes reconfigure them). */
export function liveEditors(): EditorView[] {
  return [...liveViews.values()];
}
