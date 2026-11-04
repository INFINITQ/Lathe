// Editing keys, VS Code style. CodeMirror's default keymap already matches most of VS Code
// (Alt+Up/Down moves lines, Ctrl+Shift+K deletes them, Ctrl+/ comments…); this adds the rest.

import { insertNewlineAndIndent, selectParentSyntax } from '@codemirror/commands';
import { EditorSelection, type SelectionRange } from '@codemirror/state';
import { type Command, EditorView, type KeyBinding } from '@codemirror/view';

/** Ctrl+Alt+Up / Down: a cursor on the line above / below each cursor. */
export function addCursor(direction: -1 | 1): Command {
  return (view) => {
    const { state } = view;
    const ranges: SelectionRange[] = [...state.selection.ranges];
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.head);
      const target = line.number + direction;
      if (target < 1 || target > state.doc.lines) continue;
      const next = state.doc.line(target);
      const column = range.head - line.from;
      ranges.push(EditorSelection.cursor(Math.min(next.from + column, next.to)));
    }
    if (ranges.length === state.selection.ranges.length) return false;
    view.dispatch({
      selection: EditorSelection.create(ranges, ranges.length - 1),
      scrollIntoView: true,
    });
    return true;
  };
}

/** Ctrl+Shift+Enter: a new line above, indented like the current one. */
const insertLineAbove: Command = (view) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const indent = /^\s*/.exec(line.text)![0];
    return {
      changes: { from: line.from, insert: `${indent}\n` },
      range: EditorSelection.cursor(line.from + indent.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** Ctrl+Enter: a new line below, without splitting the current one. */
const insertLineBelow: Command = (view) => {
  view.dispatch({
    selection: EditorSelection.create(
      view.state.selection.ranges.map((r) =>
        EditorSelection.cursor(view.state.doc.lineAt(r.head).to),
      ),
    ),
  });
  return insertNewlineAndIndent(view);
};

export const latheEditorKeymap: KeyBinding[] = [
  { key: 'Mod-Alt-ArrowUp', run: addCursor(-1), preventDefault: true },
  { key: 'Mod-Alt-ArrowDown', run: addCursor(1), preventDefault: true },
  { key: 'Mod-Enter', run: insertLineBelow, preventDefault: true },
  { key: 'Mod-Shift-Enter', run: insertLineAbove, preventDefault: true },
  { key: 'Shift-Alt-ArrowRight', run: selectParentSyntax, preventDefault: true },
];

/** Alt+click adds a cursor, as in VS Code (CodeMirror's default is Ctrl+click). */
export const altClickAddsCursor = EditorView.clickAddsSelectionRange.of((event) => event.altKey);
