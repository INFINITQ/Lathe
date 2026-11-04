// # %% cells in Python files (as in VS Code and Spyder): each marker line gets Run cell and Run
// below; Shift+Enter runs the cell at the cursor and moves to the next one, Ctrl+Enter runs it
// in place. Each file has its own kernel (started in the file's folder), and what cells print
// goes to the Interactive panel.

import { type Extension, Prec, RangeSetBuilder, type Text } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { create } from 'zustand';
import type { TextDoc } from '../editor/documents';
import { addDocumentExtensions } from '../editor/setup';
import { errorMessage } from '../lib/backend';
import { newId } from '../lib/events';
import { basename, dirname, pathKey } from '../lib/paths';
import { notify } from '../services/notifications';
import { showPanel } from '../workbench/layout';
import { quickInputText } from '../workbench/quickinput/store';
import { nextOutputs } from './document';
import { KernelSession, pickKernel } from './kernels';
import type { Output } from './model';

const MARKER = /^\s*#\s*%%/;

/** The cell around a position: its marker line and its code (to the next marker or the end). */
export function cellAt(
  doc: Text,
  pos: number,
): { marker: number; from: number; to: number; next: number | null } | null {
  let start = 0;
  for (let n = doc.lineAt(pos).number; n >= 1; n--) {
    if (MARKER.test(doc.line(n).text)) {
      start = n;
      break;
    }
  }
  if (!start) return null;
  let next: number | null = null;
  for (let n = start + 1; n <= doc.lines; n++) {
    if (MARKER.test(doc.line(n).text)) {
      next = n;
      break;
    }
  }
  const last = next ? next - 1 : doc.lines;
  const from = start < doc.lines ? doc.line(start + 1).from : doc.line(start).to;
  return { marker: start, from, to: Math.max(from, doc.line(last).to), next };
}

export function hasCells(doc: Text): boolean {
  for (let n = 1; n <= doc.lines; n++) if (MARKER.test(doc.line(n).text)) return true;
  return false;
}

export interface InteractiveEntry {
  id: string;
  file: string;
  line: number;
  code: string;
  outputs: Output[];
  count: number | null;
  status: 'queued' | 'running' | 'ok' | 'error' | 'aborted' | 'dead';
  ms: number | null;
}

export const useInteractive = create<{ entries: InteractiveEntry[] }>(() => ({ entries: [] }));

const sessions = new Map<string, KernelSession>();

export function interactiveOwner(path: string): string {
  return `interactive:${pathKey(path)}`;
}

/** The kernel for a file's cells (the newest file's, without one). */
export function interactiveSession(path?: string): KernelSession | null {
  const file = path ?? useInteractive.getState().entries.at(-1)?.file;
  return file ? (sessions.get(interactiveOwner(file)) ?? null) : null;
}

async function sessionFor(path: string): Promise<KernelSession | null> {
  const owner = interactiveOwner(path);
  const existing = sessions.get(owner);
  if (existing && existing.status !== 'dead') return existing;
  if (existing) {
    try {
      await existing.start();
      return existing;
    } catch (err) {
      notify('error', "The kernel didn't start.", { detail: errorMessage(err) });
      return null;
    }
  }
  const choice = await pickKernel({
    wanted: 'python3',
    always: false,
    placeholder: `Kernel for the cells in ${basename(path)}`,
  });
  if (!choice) return null;
  const session = new KernelSession(owner, choice, dirname(path));
  sessions.set(owner, session);
  try {
    await session.start();
  } catch (err) {
    sessions.delete(owner);
    notify('error', `${choice.label} didn't start.`, { detail: errorMessage(err) });
    return null;
  }
  return session;
}

function update(id: string, change: (entry: InteractiveEntry) => InteractiveEntry) {
  useInteractive.setState((s) => ({
    entries: s.entries.map((e) => (e.id === id ? change(e) : e)),
  }));
}

/** Runs code from a file's cell; its output goes to the Interactive panel. */
export async function runInteractive(path: string, cellCode: string, line: number) {
  // A cell's blank lines before the next marker aren't part of its code.
  const code = cellCode.trimEnd();
  if (!code.trim()) return;
  const session = await sessionFor(path);
  if (!session) return;
  showPanel('interactive');
  const entry: InteractiveEntry = {
    id: newId(),
    file: path,
    line,
    code: code.replace(/\s+$/, ''),
    outputs: [],
    count: null,
    status: 'queued',
    ms: null,
  };
  useInteractive.setState((s) => ({ entries: [...s.entries, entry].slice(-200) }));
  const state = { clear: false };
  const started = performance.now();
  const result = await session.execute(code, {
    output: (type, content) =>
      update(entry.id, (e) => ({
        ...e,
        status: 'running',
        outputs: nextOutputs(e.outputs, type, content, state),
      })),
    count: (count) => update(entry.id, (e) => ({ ...e, count, status: 'running' })),
    input: (prompt) =>
      void quickInputText({
        placeholder: prompt || 'Input',
        prompt: 'The kernel is waiting for input. Press Enter to send it.',
      }).then((value) => session.input(value ?? '')),
  });
  update(entry.id, (e) => ({
    ...e,
    status: result.status as InteractiveEntry['status'],
    count: result.count ?? e.count,
    ms: performance.now() - started,
  }));
}

export function clearInteractive() {
  useInteractive.setState({ entries: [] });
}

/** Runs the cell at the cursor; with `advance`, moves the cursor into the next cell. */
function runCellAtCursor(view: EditorView, doc: TextDoc, advance: boolean): boolean {
  if (!doc.path || !hasCells(view.state.doc)) return false;
  const cell = cellAt(view.state.doc, view.state.selection.main.head);
  if (!cell) return false;
  void runInteractive(doc.path, view.state.sliceDoc(cell.from, cell.to), cell.marker);
  if (advance && cell.next) {
    const target = view.state.doc.line(Math.min(cell.next + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  }
  return true;
}

/** Runs every cell from the one at `marker` to the end, in order. */
async function runBelow(view: EditorView, doc: TextDoc, marker: number) {
  if (!doc.path) return;
  let at: number | null = marker;
  while (at) {
    const cell = cellAt(view.state.doc, view.state.doc.line(at).from);
    if (!cell) break;
    await runInteractive(doc.path, view.state.sliceDoc(cell.from, cell.to), cell.marker);
    at = cell.next;
  }
}

class RunButtons extends WidgetType {
  constructor(
    readonly doc: TextDoc,
    readonly line: number,
  ) {
    super();
  }
  override eq(other: RunButtons): boolean {
    return other.line === this.line && other.doc === this.doc;
  }
  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-cellRun';
    const button = (label: string, run: () => void) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        run();
      });
      return el;
    };
    box.append(
      button('Run cell', () => {
        const cell = cellAt(view.state.doc, view.state.doc.line(this.line).from);
        if (cell && this.doc.path) {
          void runInteractive(this.doc.path, view.state.sliceDoc(cell.from, cell.to), cell.marker);
        }
      }),
      button('Run below', () => void runBelow(view, this.doc, this.line)),
    );
    return box;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const markerLine = Decoration.line({ class: 'cm-cellMarker' });

function markers(view: EditorView, doc: TextDoc): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (MARKER.test(line.text)) {
        builder.add(line.from, line.from, markerLine);
        builder.add(
          line.to,
          line.to,
          Decoration.widget({ widget: new RunButtons(doc, line.number), side: 1 }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function cells(doc: TextDoc): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = markers(view, doc);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = markers(update.view, doc);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    Prec.high(
      keymap.of([
        { key: 'Shift-Enter', run: (view) => runCellAtCursor(view, doc, true) },
        { key: 'Mod-Enter', run: (view) => runCellAtCursor(view, doc, false) },
      ]),
    ),
    EditorView.baseTheme({
      '.cm-cellMarker': {
        borderTop: '1px solid var(--line-strong)',
      },
      '.cm-cellRun': {
        marginLeft: '12px',
        fontFamily: 'var(--font-ui)',
        fontSize: '11px',
      },
      '.cm-cellRun button': {
        marginRight: '8px',
        color: 'var(--text-3)',
        cursor: 'pointer',
      },
      '.cm-cellRun button:hover': { color: 'var(--accent-fg)', textDecoration: 'underline' },
    }),
  ];
}

/** Runs the cell at the cursor of the active editor (for the command palette). */
export function runActiveCell(view: EditorView | null, doc: TextDoc | null) {
  if (!view || !doc || !runCellAtCursor(view, doc, false)) {
    notify('info', 'Put the cursor in a # %% cell of a Python file, then run it.');
  }
}

addDocumentExtensions((doc) => (doc.path && doc.languageId === 'python' ? cells(doc) : []));
