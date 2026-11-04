// Back and forward (Alt+← and Alt+→, or the mouse's side buttons), as in VS Code: the places
// you left by switching editors or by jumping more than a few lines (go to line, a search
// result, a symbol, a click far away).

import { EditorView } from '@codemirror/view';
import { getActiveDoc, getActiveView, onActiveEditorChange } from '../editor/active';
import type { TextDoc } from '../editor/documents';
import { getDocument } from '../editor/documents';
import { openDoc, openPath } from '../workbench/editors/store';

interface Place {
  docId: string;
  path: string | null;
  line: number;
  column: number;
}

const LIMIT = 50;
/** Moves this many lines or more count as jumps. */
const JUMP_LINES = 10;
const back: Place[] = [];
const forward: Place[] = [];
/** Going back or forward moves the cursor too; those moves aren't new history. */
let quietUntil = 0;

function placeIn(doc: TextDoc, state: EditorView['state'], pos = state.selection.main.head): Place {
  const line = state.doc.lineAt(Math.min(pos, state.doc.length));
  return { docId: doc.id, path: doc.path, line: line.number, column: pos - line.from + 1 };
}

const samePlace = (a: Place, b: Place) =>
  a.docId === b.docId && Math.abs(a.line - b.line) < JUMP_LINES;

function record(place: Place) {
  if (Date.now() < quietUntil) return;
  const last = back.at(-1);
  if (last && samePlace(last, place)) return;
  back.push(place);
  if (back.length > LIMIT) back.shift();
  forward.length = 0;
}

let current: { view: EditorView; doc: TextDoc } | null = null;

// Leaving an editor for another one is a place to come back to.
onActiveEditorChange((view) => {
  if (current && current.view !== view) record(placeIn(current.doc, current.view.state));
  const doc = getActiveDoc();
  current = view && doc ? { view, doc } : null;
});

/** Notices jumps inside an editor (added to every editor). */
export const navigationTracker = EditorView.updateListener.of((update) => {
  if (!update.selectionSet || update.docChanged || getActiveView() !== update.view) return;
  const before = update.startState.doc.lineAt(update.startState.selection.main.head).number;
  const after = update.state.doc.lineAt(update.state.selection.main.head).number;
  const doc = current?.view === update.view ? current.doc : null;
  if (doc && Math.abs(after - before) >= JUMP_LINES) record(placeIn(doc, update.startState));
});

function here(): Place | null {
  return current ? placeIn(current.doc, current.view.state) : null;
}

async function go(place: Place) {
  quietUntil = Date.now() + 400;
  const selection = { line: place.line, column: place.column };
  if (place.path) {
    await openPath(place.path, { selection });
    return;
  }
  const doc = getDocument(place.docId);
  if (doc) openDoc(doc, { selection });
}

export function canGoBack() {
  return back.length > 0;
}

export function canGoForward() {
  return forward.length > 0;
}

export async function goBack() {
  // Places in documents that were closed for good are skipped.
  let place = back.pop();
  while (place && !place.path && !getDocument(place.docId)) place = back.pop();
  if (!place) return;
  const now = here();
  if (now) forward.push(now);
  await go(place);
}

export async function goForward() {
  let place = forward.pop();
  while (place && !place.path && !getDocument(place.docId)) place = forward.pop();
  if (!place) return;
  const now = here();
  if (now) back.push(now);
  await go(place);
}

/** The mouse's back and forward buttons. */
export function installMouseNavigation(): () => void {
  const onMouseUp = (event: MouseEvent) => {
    if (event.button === 3) void goBack();
    else if (event.button === 4) void goForward();
    else return;
    event.preventDefault();
  };
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 3 || event.button === 4) event.preventDefault();
  };
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousedown', onMouseDown);
  return () => {
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('mousedown', onMouseDown);
  };
}
