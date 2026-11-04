// Inline blame: who last changed the line the cursor is on, when, and why (the commit's
// subject), shown faintly at the end of the line. Unsaved lines say so. Toggled by
// git.blame.inline.

import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { type GitBlameLine, backend } from '../lib/backend';
import { isUnder } from '../lib/paths';
import { useGit } from '../services/git';
import { timeAgo } from '../workbench/scm/actions';

const setBlame = StateEffect.define<GitBlameLine[]>();
const blameField = StateField.define<GitBlameLine[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBlame)) return effect.value;
    return tr.docChanged ? [] : value;
  },
});

class BlameWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: BlameWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-inlineBlame';
    span.textContent = this.text;
    return span;
  }
}

function describe(line: GitBlameLine): string {
  if (/^0+$/.test(line.hash)) return 'You, not committed yet';
  return `${line.author}, ${timeAgo(line.date)} · ${line.subject}`;
}

const blameDecoration = EditorView.decorations.compute(
  [blameField, 'selection'],
  (state): DecorationSet => {
    const lines = state.field(blameField);
    if (!lines.length) return Decoration.none;
    const cursor = state.doc.lineAt(state.selection.main.head);
    const info = lines.find((l) => l.line === cursor.number);
    if (!info) return Decoration.none;
    return Decoration.set([
      Decoration.widget({ widget: new BlameWidget(describe(info)), side: 1 }).range(cursor.to),
    ]);
  },
);

function loader(path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      destroyed = false;
      constructor(readonly view: EditorView) {
        this.schedule(100);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.schedule(900);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.load(), delay);
      }
      async load() {
        const repo = useGit.getState().repo;
        if (!repo || !isUnder(path, repo.root)) return;
        const doc = this.view.state.doc;
        const lines = await backend()
          .git.blame(repo.root, path, doc.toString())
          .catch(() => []);
        if (this.destroyed || this.view.state.doc !== doc) return;
        this.view.dispatch({ effects: setBlame.of(lines) });
      }
      destroy() {
        this.destroyed = true;
        clearTimeout(this.timer);
      }
    },
  );
}

const theme = EditorView.baseTheme({
  '.cm-inlineBlame': {
    marginLeft: '2.5em',
    color: 'var(--text-4)',
    fontFamily: 'var(--font-ui)',
    fontSize: '0.88em',
    fontStyle: 'italic',
    pointerEvents: 'none',
  },
});

export function inlineBlame(path: string) {
  return [blameField, blameDecoration, loader(path), theme];
}
