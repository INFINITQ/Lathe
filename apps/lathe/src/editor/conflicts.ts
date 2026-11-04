// Merge conflicts in the editor: the blocks between <<<<<<<, ======= and >>>>>>> are tinted,
// and each gets Accept current, Accept incoming and Accept both above it, as in VS Code.

import { type EditorState, type Range, RangeSet, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface Conflict {
  /** The <<<<<<< line's start, and the end of the >>>>>>> line (with its newline). */
  from: number;
  to: number;
  current: string;
  incoming: string;
  /** Labels after the markers ("HEAD", "feature"). */
  currentLabel: string;
  incomingLabel: string;
}

const MAX_SIZE = 4 * 1024 * 1024;

/** Every complete conflict block in the document. */
export function findConflicts(state: EditorState): Conflict[] {
  const { doc } = state;
  if (doc.length > MAX_SIZE) return [];
  const found: Conflict[] = [];
  let start: { from: number; label: string } | null = null;
  let base = -1;
  let middle = -1;
  let current: string[] = [];
  let incoming: string[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    if (text.startsWith('<<<<<<<')) {
      start = { from: line.from, label: text.slice(7).trim() };
      base = middle = -1;
      current = [];
      incoming = [];
    } else if (start && middle < 0 && text.startsWith('|||||||')) {
      base = line.from;
    } else if (start && middle < 0 && text.startsWith('=======')) {
      middle = line.from;
    } else if (start && middle >= 0 && text.startsWith('>>>>>>>')) {
      found.push({
        from: start.from,
        to: Math.min(doc.length, line.to + 1),
        current: current.map((l) => `${l}\n`).join(''),
        incoming: incoming.map((l) => `${l}\n`).join(''),
        currentLabel: start.label,
        incomingLabel: text.slice(7).trim(),
      });
      start = null;
    } else if (start) {
      if (middle >= 0) incoming.push(text);
      else if (base < 0) current.push(text);
    }
  }
  return found;
}

function accept(view: EditorView, conflict: Conflict, which: 'current' | 'incoming' | 'both') {
  const insert =
    which === 'current'
      ? conflict.current
      : which === 'incoming'
        ? conflict.incoming
        : conflict.current + conflict.incoming;
  // The block's last line may have had no newline (end of the file).
  const endsAtEnd =
    conflict.to === view.state.doc.length &&
    !view.state.sliceDoc(conflict.to - 1, conflict.to).endsWith('\n');
  view.dispatch({
    changes: {
      from: conflict.from,
      to: conflict.to,
      insert: endsAtEnd ? insert.replace(/\n$/, '') : insert,
    },
    userEvent: 'input.resolve',
  });
}

class ActionsWidget extends WidgetType {
  constructor(readonly conflict: Conflict) {
    super();
  }
  override eq(other: ActionsWidget) {
    return other.conflict.from === this.conflict.from && other.conflict.to === this.conflict.to;
  }
  toDOM(view: EditorView) {
    const bar = document.createElement('div');
    bar.className = 'cm-conflictActions';
    const link = (label: string, which: 'current' | 'incoming' | 'both') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        // Find it again: the text may have moved since this was drawn.
        const now =
          findConflicts(view.state).find((c) => c.from === this.conflict.from) ?? this.conflict;
        accept(view, now, which);
      });
      return b;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.textContent = '·';
      return s;
    };
    bar.append(
      link('Accept current', 'current'),
      sep(),
      link('Accept incoming', 'incoming'),
      sep(),
      link('Accept both', 'both'),
    );
    return bar;
  }
  override ignoreEvent() {
    return true;
  }
}

const currentLine = Decoration.line({ class: 'cm-conflict-current' });
const incomingLine = Decoration.line({ class: 'cm-conflict-incoming' });
const markerLine = Decoration.line({ class: 'cm-conflict-marker' });

function decorations(state: EditorState): DecorationSet {
  const conflicts = findConflicts(state);
  if (!conflicts.length) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const { doc } = state;
  for (const conflict of conflicts) {
    ranges.push(
      Decoration.widget({ widget: new ActionsWidget(conflict), block: true, side: -1 }).range(
        conflict.from,
      ),
    );
    let section: 'current' | 'base' | 'incoming' = 'current';
    for (let line = doc.lineAt(conflict.from); ; line = doc.line(line.number + 1)) {
      const text = line.text;
      const marker = /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/.test(text);
      if (marker) {
        ranges.push(markerLine.range(line.from));
        if (text.startsWith('|||||||')) section = 'base';
        if (text.startsWith('=======')) section = 'incoming';
      } else if (section === 'current') {
        ranges.push(currentLine.range(line.from));
      } else if (section === 'incoming') {
        ranges.push(incomingLine.range(line.from));
      }
      if (text.startsWith('>>>>>>>') || line.number >= doc.lines) break;
    }
  }
  return RangeSet.of(ranges, true);
}

const field = StateField.define<DecorationSet>({
  create: (state) => decorations(state),
  update: (value, tr) => (tr.docChanged ? decorations(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.baseTheme({
  '.cm-conflict-current': { backgroundColor: 'color-mix(in srgb, var(--info) 12%, transparent)' },
  '.cm-conflict-incoming': {
    backgroundColor: 'color-mix(in srgb, var(--accent-fg) 12%, transparent)',
  },
  '.cm-conflict-marker': { color: 'var(--text-3)', backgroundColor: 'var(--hover)' },
  '.cm-conflictActions': {
    display: 'flex',
    gap: '6px',
    padding: '1px 0',
    fontFamily: 'var(--font-ui)',
    fontSize: '11.5px',
    color: 'var(--text-4)',
  },
  '.cm-conflictActions button': { color: 'var(--text-3)', cursor: 'pointer' },
  '.cm-conflictActions button:hover': { color: 'var(--accent-fg)', textDecoration: 'underline' },
});

export const mergeConflicts = [field, theme];
