// Change bars in the gutter for files in a Git repository: added, changed and deleted lines,
// compared with the index (what `git diff` shows; staged changes have no bars). Clicking a bar
// opens the hunk under it: the lines that were there, with Revert and Stage buttons.

import { Chunk } from '@codemirror/merge';
import { RangeSet, StateEffect, StateField, Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  gutter,
} from '@codemirror/view';
import type { GitBlob } from '../lib/backend';
import { baseOf, setIndex, useGit } from '../services/git';

interface Base {
  text: Text;
  format: GitBlob['format'];
}

const setBase = StateEffect.define<Base | null>();
const baseField = StateField.define<Base | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBase)) return effect.value;
    return value;
  },
});

const setChunks = StateEffect.define<readonly Chunk[]>();
const chunkField = StateField.define<readonly Chunk[]>({
  create: () => [],
  update(chunks, tr) {
    for (const effect of tr.effects) if (effect.is(setChunks)) return effect.value;
    if (!tr.docChanged || !chunks.length) return chunks;
    // Until the diff runs again, keep the bars where the text moved. A chunk's end can be one
    // past the end of the document (its last line has no newline), so clamp before mapping.
    const length = tr.startState.doc.length;
    const map = (pos: number, assoc: number) => tr.changes.mapPos(Math.min(pos, length), assoc);
    return chunks.map(
      (c) => new Chunk(c.changes, c.fromA, c.toA, map(c.fromB, -1), map(c.toB, 1), c.precise),
    );
  },
});

/** The hunk shown under its bar (by where it starts), if any. */
const togglePeek = StateEffect.define<number | null>();
const peekField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(togglePeek)) return effect.value;
    return value === null ? null : tr.changes.mapPos(Math.min(value, tr.startState.doc.length));
  },
});

type Kind = 'added' | 'modified' | 'deleted';

function kindOf(chunk: Chunk): Kind {
  if (chunk.fromA === chunk.toA) return 'added';
  if (chunk.fromB === chunk.toB) return 'deleted';
  return 'modified';
}

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: Kind) {
    super();
  }
  override eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }
  override toDOM() {
    const el = document.createElement('div');
    el.className = `cm-gitBar cm-git-${this.kind}`;
    return el;
  }
}

const markers = {
  added: new ChangeMarker('added'),
  modified: new ChangeMarker('modified'),
  deleted: new ChangeMarker('deleted'),
};

function chunkAtLine(view: EditorView, lineFrom: number): Chunk | null {
  const { doc } = view.state;
  const line = doc.lineAt(lineFrom).number;
  for (const chunk of view.state.field(chunkField)) {
    const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
    const last =
      chunk.fromB === chunk.toB
        ? first
        : doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.toB, doc.length) - 1)).number;
    if (line >= first && line <= last) return chunk;
  }
  return null;
}

const changeGutter = gutter({
  class: 'cm-gitGutter',
  markers(view) {
    const { doc } = view.state;
    const ranges = [];
    for (const chunk of view.state.field(chunkField)) {
      const kind = kindOf(chunk);
      const start = Math.min(chunk.fromB, doc.length);
      if (kind === 'deleted') {
        ranges.push(markers.deleted.range(doc.lineAt(start).from));
        continue;
      }
      const end = Math.max(start, Math.min(chunk.toB, doc.length) - 1);
      for (let line = doc.lineAt(start).number; line <= doc.lineAt(end).number; line++) {
        ranges.push(markers[kind].range(doc.line(line).from));
      }
    }
    return RangeSet.of(ranges, true);
  },
  domEventHandlers: {
    mousedown(view, line) {
      const chunk = chunkAtLine(view, line.from);
      if (!chunk) return false;
      const open = view.state.field(peekField);
      view.dispatch({ effects: togglePeek.of(open === chunk.fromB ? null : chunk.fromB) });
      return true;
    },
  },
});

/** Reverts a hunk in the editor: its lines go back to what the index has. */
function revert(view: EditorView, chunk: Chunk) {
  const base = view.state.field(baseField);
  if (!base) return;
  view.dispatch({
    changes: {
      from: chunk.fromB,
      to: chunk.endB,
      insert: base.text.sliceString(chunk.fromA, chunk.endA),
    },
    effects: togglePeek.of(null),
    userEvent: 'revert',
  });
}

/** Stages just this hunk: the index gets its lines from the editor, the rest stays. */
async function stageHunk(view: EditorView, chunk: Chunk, path: string) {
  const base = view.state.field(baseField);
  if (!base) return;
  const current = view.state.doc;
  const staged = base.text.replace(chunk.fromA, chunk.endA, current.slice(chunk.fromB, chunk.endB));
  view.dispatch({ effects: togglePeek.of(null) });
  await setIndex(path, staged.toString(), base.format);
}

class PeekWidget extends WidgetType {
  constructor(
    readonly chunk: Chunk,
    readonly original: string,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: PeekWidget) {
    return other.original === this.original && other.chunk.fromB === this.chunk.fromB;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-gitPeek';
    const bar = document.createElement('div');
    bar.className = 'cm-gitPeek-bar';
    const title = document.createElement('span');
    title.textContent =
      kindOf(this.chunk) === 'added'
        ? 'Added lines'
        : kindOf(this.chunk) === 'deleted'
          ? 'Deleted lines'
          : 'Changed lines';
    bar.append(title);
    const button = (label: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        run();
      });
      bar.append(b);
    };
    button('Revert', () => revert(view, this.chunk));
    button('Stage', () => void stageHunk(view, this.chunk, this.path));
    button('Close', () => view.dispatch({ effects: togglePeek.of(null) }));
    box.append(bar);
    if (this.original) {
      const pre = document.createElement('pre');
      pre.className = 'cm-gitPeek-old';
      pre.textContent = this.original.replace(/\n$/, '');
      box.append(pre);
    }
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

function peekDecorations(path: string) {
  return EditorView.decorations.compute(
    [peekField, chunkField, baseField],
    (state): DecorationSet => {
      const at = state.field(peekField);
      const base = state.field(baseField);
      if (at === null || !base) return Decoration.none;
      const chunk = state.field(chunkField).find((c) => c.fromB === at);
      if (!chunk) return Decoration.none;
      const { doc } = state;
      const end =
        chunk.fromB === chunk.toB
          ? Math.min(chunk.fromB, doc.length)
          : Math.max(chunk.fromB, Math.min(chunk.toB, doc.length) - 1);
      const widget = new PeekWidget(chunk, base.text.sliceString(chunk.fromA, chunk.endA), path);
      return Decoration.set([
        Decoration.widget({ widget, block: true, side: 1 }).range(doc.lineAt(end).to),
      ]);
    },
  );
}

/** Loads the base (and again when Git's state moves on) and diffs a moment after typing. */
function tracker(path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      stop: () => void;
      revision = -1;
      destroyed = false;
      constructor(readonly view: EditorView) {
        this.stop = useGit.subscribe((s) => {
          if (s.revision !== this.revision) void this.load();
        });
        void this.load();
      }
      async load() {
        this.revision = useGit.getState().revision;
        const blob = await baseOf(path, 'index');
        if (this.destroyed) return;
        const base = blob ? { text: Text.of(blob.text.split('\n')), format: blob.format } : null;
        this.view.dispatch({ effects: setBase.of(base) });
        this.diff();
      }
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.diff(), 200);
      }
      diff() {
        if (this.destroyed) return;
        const base = this.view.state.field(baseField);
        const chunks = base ? Chunk.build(base.text, this.view.state.doc, { scanLimit: 5000 }) : [];
        this.view.dispatch({ effects: setChunks.of(chunks) });
      }
      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.stop();
      }
    },
  );
}

const theme = EditorView.baseTheme({
  '.cm-gitGutter': { width: '4px', paddingLeft: '1px' },
  '.cm-gitGutter .cm-gutterElement': { cursor: 'pointer' },
  '.cm-gitBar': { width: '3px', height: '100%' },
  '.cm-git-added': { backgroundColor: 'var(--accent-fg)' },
  '.cm-git-modified': { backgroundColor: 'var(--info)' },
  '.cm-git-deleted': {
    height: '0',
    marginTop: '-3px',
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    borderLeft: '4px solid var(--danger)',
  },
  '.cm-gitPeek': {
    margin: '2px 0 4px',
    border: '1px solid var(--line-strong)',
    borderRadius: '4px',
    backgroundColor: 'var(--bg-raised)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
  },
  '.cm-gitPeek-bar': {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px',
    color: 'var(--text-3)',
    borderBottom: '1px solid var(--line)',
  },
  '.cm-gitPeek-bar span': { flex: '1' },
  '.cm-gitPeek-bar button': {
    padding: '1px 8px',
    borderRadius: '3px',
    color: 'var(--text-2)',
    cursor: 'pointer',
  },
  '.cm-gitPeek-bar button:hover': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
  '.cm-gitPeek-old': {
    margin: '0',
    padding: '4px 8px',
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--code-size)',
    whiteSpace: 'pre-wrap',
    backgroundColor: 'color-mix(in srgb, var(--danger) 9%, transparent)',
    color: 'var(--text-2)',
  },
});

/** Change bars for a file (only shows anything while it's in a repository). */
export function gitGutter(path: string) {
  return [
    baseField,
    chunkField,
    peekField,
    changeGutter,
    peekDecorations(path),
    tracker(path),
    theme,
  ];
}
