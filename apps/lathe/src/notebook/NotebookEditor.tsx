// The notebook editor: a toolbar, then the cells. Code cells get their own CodeMirror editor
// (created once a cell comes near the screen, so long notebooks open fast) with completions and
// hover from the kernel; Markdown cells show rendered until you edit them. Keys follow Jupyter:
// Shift+Enter runs and moves on, Ctrl+Enter runs, Alt+Enter runs and adds a cell; Escape leaves
// a cell, then A/B add above/below, D D deletes, M/Y switch Markdown/code, Enter edits.

import {
  type CompletionSource,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  placeholder,
} from '@codemirror/view';
import {
  ArrowDown,
  ArrowUp,
  Brush,
  ChevronsRight,
  Code2,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Square,
  Text as TextIcon,
  Trash2,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { TextDoc } from '../editor/documents';
import { detectLanguage } from '../editor/languages';
import { setActiveEditor } from '../editor/active';
import { latheTheme } from '../editor/theme';
import { plainText } from '../lib/ansi';
import { cn } from '../lib/cn';
import { type NotebookDoc, focusCell, notebookFor, releaseNotebookSoon } from './document';
import { fromCodePoints, toCodePoints, useKernels } from './kernels';
import type { Cell } from './model';
import { Outputs, renderMarkdown } from './outputs';

const toolButton =
  'flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-[11.5px] text-text-2 hover:bg-hover hover:text-text disabled:text-text-4 disabled:hover:bg-transparent [&>svg]:size-3.5';
const iconButton =
  'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';

function kernelCompletions(nb: NotebookDoc): CompletionSource {
  return async (context) => {
    const kernel = nb.kernel;
    if (!kernel || kernel.status !== 'idle') return null;
    const word = context.matchBefore(/[\w$.]*/);
    if (!context.explicit && (!word || word.from === word.to)) return null;
    const code = context.state.doc.toString();
    const reply = await kernel.complete(code, toCodePoints(code, context.pos));
    if (!reply?.matches.length) return null;
    return {
      from: fromCodePoints(code, reply.start),
      to: fromCodePoints(code, reply.end),
      options: reply.matches.map((label) => ({ label })),
      validFor: /^[\w$]*$/,
    };
  };
}

function kernelHover(nb: NotebookDoc) {
  return hoverTooltip(
    async (view, pos) => {
      const kernel = nb.kernel;
      if (!kernel || kernel.status !== 'idle') return null;
      const code = view.state.doc.toString();
      const text = await kernel.inspect(code, toCodePoints(code, pos));
      if (!text) return null;
      return {
        pos,
        above: true,
        create: () => {
          const dom = document.createElement('pre');
          dom.className = 'nb-inspect';
          dom.textContent = plainText(text).trim();
          return { dom };
        },
      };
    },
    { hoverTime: 500 },
  );
}

const cellTheme = EditorView.theme({
  // As tall as its code (the editors' shared theme fills the parent).
  '&': { backgroundColor: 'transparent', height: 'auto' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { padding: '7px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
});

function languageFile(nb: NotebookDoc, cell: Cell): string {
  if (cell.cell_type === 'markdown') return 'cell.md';
  if (cell.cell_type === 'raw') return 'cell.txt';
  const info = nb.notebook.metadata.language_info as { file_extension?: unknown } | undefined;
  const ext = typeof info?.file_extension === 'string' ? info.file_extension : '.py';
  return `cell${ext.startsWith('.') ? ext : `.${ext}`}`;
}

function CellEditor({ nb, cell, index }: { nb: NotebookDoc; cell: Cell; index: number }) {
  const host = useRef<HTMLDivElement>(null);
  const language = useMemo(() => new Compartment(), []);
  const file = languageFile(nb, cell);

  // Created during the render that shows the cell, so a new cell takes the very next key.
  useLayoutEffect(() => {
    const key = cell.key;
    const leaveUp = (view: EditorView, delta: -1 | 1) => {
      const { head, empty } = view.state.selection.main;
      const line = view.state.doc.lineAt(head);
      const edge = delta < 0 ? line.number === 1 : line.number === view.state.doc.lines;
      if (!empty || !edge || completionStatus(view.state)) return false;
      const next = nb.notebook.cells[nb.indexOf(key) + delta];
      if (!next) return false;
      nb.select(next.key, true);
      focusCell(nb, next.key);
      return true;
    };
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: cell.source,
        extensions: [
          Prec.highest(
            keymap.of([
              { key: 'Shift-Enter', run: () => (void nb.runAndAdvance(key), true) },
              { key: 'Mod-Enter', run: () => (void nb.run([key]), true) },
              { key: 'Alt-Enter', run: () => (void nb.runAndInsert(key), true) },
              {
                key: 'Escape',
                run: (v) => {
                  if (completionStatus(v.state)) return false;
                  nb.select(key, false);
                  focusCell(nb, key);
                  return true;
                },
              },
              { key: 'ArrowUp', run: (v) => leaveUp(v, -1) },
              { key: 'ArrowDown', run: (v) => leaveUp(v, 1) },
              {
                key: 'Ctrl-Shift--',
                run: (v) => {
                  const second = nb.splitCell(key, v.state.selection.main.head);
                  if (second) {
                    nb.select(second, true);
                    focusCell(nb, second);
                  }
                  return true;
                },
              },
            ]),
          ),
          history(),
          drawSelection(),
          highlightSpecialChars(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          EditorState.allowMultipleSelections.of(true),
          indentUnit.of('    '),
          cell.cell_type === 'code'
            ? [autocompletion({ override: [kernelCompletions(nb)], icons: false }), kernelHover(nb)]
            : [],
          placeholder(cell.cell_type === 'markdown' ? 'Markdown' : ''),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          language.of([]),
          latheTheme,
          Prec.highest(cellTheme),
          EditorView.contentAttributes.of({
            'aria-label': `Cell ${index + 1} (${cell.cell_type === 'code' ? 'code' : cell.cell_type})`,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) nb.setSource(key, update.state.doc.toString());
            if (update.focusChanged && update.view.hasFocus && nb.editing !== key) {
              nb.select(key, true);
            }
          }),
        ],
      }),
    });
    nb.views.set(key, view);
    if (nb.editing === key) view.focus();
    return () => {
      if (nb.views.get(key) === view) nb.views.delete(key);
      view.destroy();
    };
    // One editor per cell for its whole life; its text follows outside changes below.
  }, [nb, cell.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const view = nb.views.get(cell.key);
    if (!view) return;
    let cancelled = false;
    const description = detectLanguage(file);
    void description?.load().then((support) => {
      if (!cancelled) view.dispatch({ effects: language.reconfigure(support) });
    });
    return () => {
      cancelled = true;
    };
  }, [nb, cell.key, file, language]);

  // A reload or a type change replaces the text from outside.
  useEffect(() => {
    const view = nb.views.get(cell.key);
    if (view && view.state.doc.toString() !== cell.source) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cell.source } });
    }
  }, [nb, cell.key, cell.source]);

  return <div ref={host} className="min-h-[34px]" />;
}

/** The cell's editor once it's near the screen; until then its text, the same size. */
function LazyEditor({ nb, cell, index }: { nb: NotebookDoc; cell: Cell; index: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(nb.editing === cell.key);
  useEffect(() => {
    if (near) return;
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    if (nb.editing === cell.key) setNear(true);
  }, [nb, nb.editing, cell.key]);
  if (near) return <CellEditor nb={nb} cell={cell} index={index} />;
  return (
    <div ref={holder} onMouseDown={() => setNear(true)}>
      <pre className="nb-placeholder">{cell.source || ' '}</pre>
    </div>
  );
}

function Timing({ nb, cell }: { nb: NotebookDoc; cell: Cell }) {
  const state = nb.running.get(cell.key);
  const timing = nb.timings.get(cell.key);
  if (state) {
    return (
      <p className="nb-timing" aria-live="polite">
        <LoaderCircle className="size-3 animate-spin" />
        {state === 'queued' ? 'Waiting' : 'Running'}
      </p>
    );
  }
  if (!timing) return null;
  const failed = timing.status !== 'ok';
  return (
    <p className={cn('nb-timing', failed && 'text-danger')} data-status={timing.status}>
      {failed ? '✕' : '✓'} {(timing.ms / 1000).toFixed(timing.ms < 10_000 ? 1 : 0)}s
      {timing.status === 'aborted' && ' · not run'}
    </p>
  );
}

const CellView = memo(function CellView({
  nb,
  cell,
  index,
  selected,
  editing,
  running,
}: {
  nb: NotebookDoc;
  cell: Cell;
  index: number;
  selected: boolean;
  editing: boolean;
  running: string | undefined;
}) {
  const code = cell.cell_type === 'code';
  const showMarkdown = cell.cell_type === 'markdown' && !editing;
  const count = running ? '*' : (cell.execution_count ?? ' ');
  return (
    <div
      role="listitem"
      aria-label={`Cell ${index + 1}, ${cell.cell_type}`}
      data-cell={cell.key}
      data-selected={selected}
      data-editing={editing}
      tabIndex={selected ? 0 : -1}
      className={cn('nb-cell group/cell', selected && 'nb-selected', editing && 'nb-editing')}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('.cm-editor')) return;
        nb.select(cell.key, nb.editing === cell.key);
      }}
    >
      <div className="nb-gutter">
        {code ? (
          <>
            <button
              type="button"
              aria-label={`Run cell ${index + 1}`}
              title="Run cell (Ctrl+Enter)"
              className="nb-run"
              onClick={() => void nb.run([cell.key])}
            >
              {running ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
            </button>
            <span className="nb-count" aria-label={`Execution count ${count}`}>
              [{count}]
            </span>
          </>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {showMarkdown ? (
          <div
            className="nb-markdown nb-rendered"
            onDoubleClick={() => {
              nb.select(cell.key, true);
              focusCell(nb, cell.key);
            }}
            dangerouslySetInnerHTML={{
              __html: cell.source.trim()
                ? renderMarkdown(cell.source, cell.attachments)
                : '<p class="nb-empty">Double-click to write Markdown.</p>',
            }}
          />
        ) : (
          <div className="nb-input">
            <LazyEditor nb={nb} cell={cell} index={index} />
          </div>
        )}
        {code && cell.outputs.length > 0 && <Outputs outputs={cell.outputs} />}
        {code && <Timing nb={nb} cell={cell} />}
      </div>
      <div className="nb-actions">
        <button
          type="button"
          aria-label="Move cell up"
          title="Move up"
          className={iconButton}
          onClick={() => nb.moveCell(cell.key, -1)}
        >
          <ArrowUp />
        </button>
        <button
          type="button"
          aria-label="Move cell down"
          title="Move down"
          className={iconButton}
          onClick={() => nb.moveCell(cell.key, 1)}
        >
          <ArrowDown />
        </button>
        <button
          type="button"
          aria-label={code ? 'Make it a Markdown cell' : 'Make it a code cell'}
          title={code ? 'Markdown (M)' : 'Code (Y)'}
          className={iconButton}
          onClick={() => nb.setType(cell.key, code ? 'markdown' : 'code')}
        >
          {code ? <TextIcon /> : <Code2 />}
        </button>
        <button
          type="button"
          aria-label="Delete cell"
          title="Delete (D D)"
          className={iconButton}
          onClick={() => nb.deleteCell(cell.key)}
        >
          <Trash2 />
        </button>
      </div>
    </div>
  );
});

function AddCell({ nb, at }: { nb: NotebookDoc; at: number }) {
  const add = (type: 'code' | 'markdown') => {
    const key = nb.insertCell(at, type);
    nb.select(key, true);
    focusCell(nb, key);
  };
  return (
    <div className="nb-add">
      <button type="button" className={toolButton} onClick={() => add('code')}>
        <Plus />
        Code
      </button>
      <button type="button" className={toolButton} onClick={() => add('markdown')}>
        <Plus />
        Markdown
      </button>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  starting: 'starting',
  idle: 'idle',
  busy: 'busy',
  restarting: 'restarting',
  dead: 'stopped',
};

function Toolbar({ nb }: { nb: NotebookDoc }) {
  const status = useKernels((s) => s.status[nb.doc.id]);
  const label = useKernels((s) => s.label[nb.doc.id]);
  const add = (type: 'code' | 'markdown') => {
    const at = nb.selected ? nb.indexOf(nb.selected) + 1 : nb.notebook.cells.length;
    const key = nb.insertCell(at, type);
    nb.select(key, true);
    focusCell(nb, key);
  };
  const busy = status === 'busy' || status === 'starting' || status === 'restarting';
  return (
    <div role="toolbar" aria-label="Notebook" className="nb-toolbar">
      <button
        type="button"
        aria-label="Add code cell"
        className={toolButton}
        onClick={() => add('code')}
      >
        <Plus />
        Code
      </button>
      <button
        type="button"
        aria-label="Add Markdown cell"
        className={toolButton}
        onClick={() => add('markdown')}
      >
        <Plus />
        Markdown
      </button>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
      <button
        type="button"
        aria-label="Run all"
        className={toolButton}
        onClick={() => void nb.runAll()}
      >
        <ChevronsRight />
        Run all
      </button>
      <button
        type="button"
        aria-label="Interrupt the kernel"
        title="Interrupt"
        className={toolButton}
        disabled={!busy}
        onClick={() => void nb.interrupt()}
      >
        <Square className="fill-current" />
        Interrupt
      </button>
      <button
        type="button"
        aria-label="Restart the kernel"
        title="Restart"
        className={toolButton}
        disabled={!nb.kernel}
        onClick={() => void nb.restart()}
      >
        <RotateCcw />
        Restart
      </button>
      <button
        type="button"
        aria-label="Clear all outputs"
        title="Clear all outputs"
        className={toolButton}
        onClick={() => nb.clearOutputs()}
      >
        <Brush />
        Clear outputs
      </button>
      <span className="flex-1" />
      <button
        type="button"
        aria-label={label ? `Kernel ${label}: ${STATUS_TEXT[status ?? 'dead']}` : 'Select a kernel'}
        title="Select a kernel"
        className={cn(toolButton, 'max-w-[40%]')}
        onClick={() => void nb.selectKernel()}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            !label || status === 'dead'
              ? 'border border-text-3'
              : busy
                ? 'bg-accent-fg animate-pulse'
                : 'bg-accent-fg',
          )}
        />
        <span className="truncate">{label ?? 'Select a kernel'}</span>
        {label && <span className="shrink-0 text-text-3">{STATUS_TEXT[status ?? 'dead']}</span>}
      </button>
    </div>
  );
}

export function NotebookEditor({ doc }: { doc: TextDoc }) {
  const nb = useMemo(() => notebookFor(doc), [doc]);
  useSyncExternalStore(nb.subscribe, nb.getVersion);
  const lastD = useRef(0);

  useEffect(() => () => releaseNotebookSoon(doc.id), [doc.id]);
  // The status bar's line, column and encoding belong to text editors, not to a notebook.
  useEffect(() => setActiveEditor(null, null), [doc.id]);
  useEffect(() => {
    if (!nb.selected && nb.notebook.cells[0]) nb.select(nb.notebook.cells[0].key);
  }, [nb]);

  if (nb.error) {
    return (
      <div className="p-6 text-[12.5px] text-text-2">
        <p className="text-text">Lathe can't show this notebook.</p>
        <p className="mt-1 text-text-3">{nb.error}</p>
      </div>
    );
  }

  const cells = nb.notebook.cells;
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.cm-editor, input, textarea, button')) return;
    const key = nb.selected;
    if (!key) return;
    const at = nb.indexOf(key);
    const go = (i: number) => {
      const cell = cells[i];
      if (!cell) return;
      nb.select(cell.key);
      focusCell(nb, cell.key);
    };
    const insert = (index: number) => {
      const added = nb.insertCell(index, 'code');
      nb.select(added, true);
      focusCell(nb, added);
    };
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'Enter' && e.shiftKey) void nb.runAndAdvance(key);
    else if (e.key === 'Enter' && e.ctrlKey) void nb.run([key]);
    else if (e.key === 'Enter' && e.altKey) void nb.runAndInsert(key);
    else if (e.key === 'Enter' && plain) {
      nb.select(key, true);
      focusCell(nb, key);
    } else if ((e.key === 'ArrowUp' || e.key === 'k') && plain) go(at - 1);
    else if ((e.key === 'ArrowDown' || e.key === 'j') && plain) go(at + 1);
    else if (e.key === 'a' && plain) insert(at);
    else if (e.key === 'b' && plain) insert(at + 1);
    else if (e.key === 'm' && plain) nb.setType(key, 'markdown');
    else if (e.key === 'y' && plain) nb.setType(key, 'code');
    else if (e.key === 'd' && plain) {
      if (Date.now() - lastD.current < 600) {
        lastD.current = 0;
        nb.deleteCell(key);
        if (nb.selected) focusCell(nb, nb.selected);
      } else lastD.current = Date.now();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-notebook={doc.path ?? doc.name}>
      <Toolbar nb={nb} />
      <div className="min-h-0 flex-1 overflow-y-auto" onKeyDown={onKeyDown}>
        <div role="list" aria-label="Cells" className="nb-cells">
          {cells.map((cell, i) => (
            <CellView
              key={cell.key}
              nb={nb}
              cell={cell}
              index={i}
              selected={nb.selected === cell.key}
              editing={nb.editing === cell.key}
              running={nb.running.get(cell.key)}
            />
          ))}
          <AddCell nb={nb} at={cells.length} />
        </div>
      </div>
    </div>
  );
}
