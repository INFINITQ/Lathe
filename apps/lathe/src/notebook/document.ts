// An open notebook: the cells of a TextDoc's .ipynb JSON. Edits change the cells, and shortly
// after, the document's text, so saving, hot exit and "changed on disk" work as for any file.
// It also runs cells on the notebook's kernel and writes their outputs into the cells.

import type { EditorView } from '@codemirror/view';
import { Text } from '@codemirror/state';
import { type TextDoc, addSaveParticipant, getDocument } from '../editor/documents';
import { errorMessage } from '../lib/backend';
import { dirname } from '../lib/paths';
import { notify } from '../services/notifications';
import { quickInputText } from '../workbench/quickinput/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { type KernelChoice, KernelSession, pickKernel, rescanKernels } from './kernels';
import {
  type Cell,
  type CellType,
  type MimeBundle,
  type Notebook,
  type Output,
  emptyNotebook,
  newCell,
  parseNotebook,
  serializeNotebook,
} from './model';

export interface Timing {
  ms: number;
  status: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A cell's outputs after one more kernel message (stream, display_data, execute_result, error,
 * clear_output). Printing in pieces joins one stream output; clear_output with `wait` clears
 * when the next output arrives (`state` carries that between messages).
 */
export function nextOutputs(
  current: Output[],
  type: string,
  content: Record<string, unknown>,
  state: { clear: boolean },
): Output[] {
  if (type === 'clear_output') {
    if (content.wait === true) {
      state.clear = true;
      return current;
    }
    return [];
  }
  const outputs = state.clear ? [] : current;
  state.clear = false;
  if (type === 'stream') {
    const name = String(content.name ?? 'stdout');
    const text = String(content.text ?? '');
    const last = outputs.at(-1);
    return last?.output_type === 'stream' && last.name === name
      ? [...outputs.slice(0, -1), { ...last, text: last.text + text }]
      : [...outputs, { output_type: 'stream', name, text }];
  }
  if (type === 'error') {
    return [
      ...outputs,
      {
        output_type: 'error',
        ename: String(content.ename ?? 'Error'),
        evalue: String(content.evalue ?? ''),
        traceback: Array.isArray(content.traceback) ? content.traceback.map(String) : [],
      },
    ];
  }
  if (type === 'execute_result') {
    return [
      ...outputs,
      {
        output_type: 'execute_result',
        data: record(content.data) as MimeBundle,
        metadata: record(content.metadata),
        execution_count:
          typeof content.execution_count === 'number' ? content.execution_count : null,
        transient: record(content.transient),
      },
    ];
  }
  if (type === 'display_data') {
    return [
      ...outputs,
      {
        output_type: 'display_data',
        data: record(content.data) as MimeBundle,
        metadata: record(content.metadata),
        transient: record(content.transient),
      },
    ];
  }
  return current;
}

function displayId(output: Output): string | undefined {
  if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') return;
  const id = output.transient?.display_id;
  return typeof id === 'string' ? id : undefined;
}

export class NotebookDoc {
  notebook: Notebook;
  /** Set when the file isn't a notebook Lathe can read. */
  error: string | null = null;
  /** The selected cell, and whether you're typing in it (edit mode) or not (command mode). */
  selected: string | null = null;
  editing: string | null = null;
  /** Cells waiting for the kernel or running. */
  readonly running = new Map<string, 'queued' | 'running'>();
  /** How long each cell took last time it ran (not saved). */
  readonly timings = new Map<string, Timing>();
  /** Each cell's editor, while it has one. */
  readonly views = new Map<string, EditorView>();
  kernel: KernelSession | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private lastText: Text;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private emitPending = false;
  private urgentPending = false;
  private readonly stopWatching: () => void;

  constructor(readonly doc: TextDoc) {
    this.lastText = doc.text;
    this.notebook = this.read();
    const listener = () => this.textChanged();
    doc.textListeners.add(listener);
    this.stopWatching = () => doc.textListeners.delete(listener);
  }

  private read(): Notebook {
    try {
      this.error = null;
      const notebook = parseNotebook(this.doc.text.toString());
      return notebook.cells.length ? notebook : { ...notebook, cells: [newCell('code')] };
    } catch (err) {
      this.error = errorMessage(err);
      return emptyNotebook();
    }
  }

  /** The text changed under us (a reload from disk, a restored backup): read it again. */
  private textChanged() {
    if (this.doc.text === this.lastText) return;
    this.lastText = this.doc.text;
    this.notebook = this.read();
    this.running.clear();
    this.emit();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getVersion = () => this.version;

  private notify() {
    this.version++;
    this.listeners.forEach((l) => l());
  }

  /**
   * Repaints. What you do repaints before the next key arrives (a new cell's editor is there to
   * type into); kernel output (`soon`) repaints once per frame, however much of it arrives.
   */
  emit(soon = false) {
    if (!soon) {
      if (this.urgentPending) return;
      this.urgentPending = true;
      queueMicrotask(() => {
        this.urgentPending = false;
        this.notify();
      });
      return;
    }
    if (this.emitPending) return;
    this.emitPending = true;
    const flush = () => {
      this.emitPending = false;
      this.notify();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 0);
  }

  /** Writes the cells into the document's text soon (now with `now`). */
  private sync(now = false) {
    if (this.error) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (now) {
      this.flush();
      return;
    }
    this.syncTimer = setTimeout(() => this.flush(), 300);
  }

  /** Puts the cells into the document's text (before a save, and after edits). */
  flush() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    if (this.error) return;
    const text = serializeNotebook(this.notebook);
    if (text === this.lastText.toString()) return;
    this.lastText = Text.of(text.split('\n'));
    this.doc.setText(this.lastText);
  }

  cell(key: string): Cell | undefined {
    return this.notebook.cells.find((c) => c.key === key);
  }

  indexOf(key: string): number {
    return this.notebook.cells.findIndex((c) => c.key === key);
  }

  private change(next: Notebook, soon = false) {
    this.notebook = next;
    this.emit(soon);
    this.sync();
  }

  private patchCell(key: string, patch: Partial<Cell>, soon = false) {
    const cells = this.notebook.cells.map((c) => (c.key === key ? { ...c, ...patch } : c));
    this.change({ ...this.notebook, cells }, soon);
  }

  /** From a cell's editor, as you type: no repaint needed. */
  setSource(key: string, source: string) {
    const cell = this.cell(key);
    if (!cell || cell.source === source) return;
    cell.source = source;
    this.sync();
  }

  select(key: string | null, edit = false) {
    const editing = edit ? key : null;
    if (this.selected === key && this.editing === editing) return;
    this.selected = key;
    this.editing = editing;
    this.emit();
  }

  /** Adds a cell at an index (the end by default); returns its key. */
  insertCell(at: number, type: CellType = 'code', source = ''): string {
    const cell = newCell(type, source, this.notebook.nbformat_minor >= 5);
    const cells = [...this.notebook.cells];
    cells.splice(Math.max(0, Math.min(at, cells.length)), 0, cell);
    this.change({ ...this.notebook, cells });
    return cell.key;
  }

  deleteCell(key: string) {
    const at = this.indexOf(key);
    if (at < 0) return;
    let cells = this.notebook.cells.filter((c) => c.key !== key);
    if (!cells.length) cells = [newCell('code', '', this.notebook.nbformat_minor >= 5)];
    this.selected = cells[Math.min(at, cells.length - 1)]!.key;
    this.editing = null;
    this.views.delete(key);
    this.change({ ...this.notebook, cells });
  }

  moveCell(key: string, delta: number) {
    const at = this.indexOf(key);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= this.notebook.cells.length) return;
    const cells = [...this.notebook.cells];
    const [cell] = cells.splice(at, 1);
    cells.splice(to, 0, cell!);
    this.change({ ...this.notebook, cells });
  }

  setType(key: string, type: CellType) {
    const cell = this.cell(key);
    if (!cell || cell.cell_type === type) return;
    this.patchCell(key, {
      cell_type: type,
      outputs: [],
      execution_count: null,
    });
  }

  /** Splits a cell at an offset of its source; the second half gets the cursor. */
  splitCell(key: string, offset: number): string | null {
    const cell = this.cell(key);
    if (!cell) return null;
    const before = cell.source.slice(0, offset).replace(/\n$/, '');
    const after = cell.source.slice(offset).replace(/^\n/, '');
    const at = this.indexOf(key);
    const second = newCell(cell.cell_type, after, this.notebook.nbformat_minor >= 5);
    const cells = [...this.notebook.cells];
    cells.splice(at, 1, { ...cell, source: before }, second);
    this.change({ ...this.notebook, cells });
    return second.key;
  }

  clearOutputs(key?: string) {
    const cells = this.notebook.cells.map((c) =>
      (key === undefined || c.key === key) && c.cell_type === 'code'
        ? { ...c, outputs: [], execution_count: null }
        : c,
    );
    if (key === undefined) this.timings.clear();
    else this.timings.delete(key);
    this.change({ ...this.notebook, cells });
  }

  // ---- Running ----

  private apply(
    key: string,
    type: string,
    content: Record<string, unknown>,
    state: { clear: boolean },
  ) {
    const cell = this.cell(key);
    if (!cell) return;
    if (type === 'update_display_data') {
      this.updateDisplay(content);
      return;
    }
    const outputs = nextOutputs(cell.outputs, type, content, state);
    if (outputs !== cell.outputs) this.patchCell(key, { outputs }, true);
  }

  /** update_display_data: replaces every output shown with that display id. */
  private updateDisplay(content: Record<string, unknown>) {
    const id = record(content.transient).display_id;
    if (typeof id !== 'string') return;
    const cells = this.notebook.cells.map((cell) => {
      if (!cell.outputs.some((o) => displayId(o) === id)) return cell;
      return {
        ...cell,
        outputs: cell.outputs.map((o) =>
          displayId(o) === id &&
          (o.output_type === 'display_data' || o.output_type === 'execute_result')
            ? { ...o, data: record(content.data) as MimeBundle, metadata: record(content.metadata) }
            : o,
        ),
      };
    });
    this.change({ ...this.notebook, cells });
  }

  /** Runs code cells in order (markdown cells just leave edit mode). */
  async run(keys: string[]) {
    const code = keys.filter(
      (k) => this.cell(k)?.cell_type === 'code' && this.cell(k)!.source.trim(),
    );
    if (keys.includes(this.editing ?? '') && this.cell(this.editing!)?.cell_type === 'markdown') {
      this.editing = null;
      this.emit();
    }
    if (!code.length) return;
    const kernel = await this.ensureKernel();
    if (!kernel) return;
    const runs = code.map((key) => {
      const cell = this.cell(key)!;
      const state = { clear: false };
      const started = performance.now();
      this.running.set(key, 'queued');
      this.timings.delete(key);
      this.patchCell(key, { outputs: [], execution_count: null });
      return kernel
        .execute(cell.source, {
          output: (type, content) => {
            this.running.set(key, 'running');
            this.apply(key, type, content, state);
          },
          count: (count) => {
            this.running.set(key, 'running');
            this.patchCell(key, { execution_count: count });
          },
          input: (prompt, password) => void this.askInput(kernel, prompt, password),
        })
        .then(({ status, count }) => {
          this.running.delete(key);
          if (count !== null && this.cell(key)) this.patchCell(key, { execution_count: count });
          this.timings.set(key, { ms: performance.now() - started, status });
          this.emit();
        });
    });
    this.emit();
    await Promise.all(runs);
  }

  async runAll() {
    await this.run(this.notebook.cells.map((c) => c.key));
  }

  /** Shift+Enter: runs the cell and moves to the next one (adding one at the end). */
  async runAndAdvance(key: string) {
    const at = this.indexOf(key);
    const next = this.notebook.cells[at + 1]?.key ?? this.insertCell(at + 1, 'code');
    const cell = this.cell(next)!;
    this.select(next, cell.cell_type === 'code' && !cell.source);
    focusCell(this, next);
    await this.run([key]);
  }

  /** Alt+Enter: runs the cell and adds one below it. */
  async runAndInsert(key: string) {
    const next = this.insertCell(this.indexOf(key) + 1, 'code');
    this.select(next, true);
    focusCell(this, next);
    await this.run([key]);
  }

  private async askInput(kernel: KernelSession, prompt: string, password: boolean) {
    const value = await quickInputText({
      placeholder: prompt || 'Input',
      prompt: `The kernel is waiting for ${password ? 'a password' : 'input'}. Press Enter to send it.`,
    });
    await kernel.input(value ?? '').catch(() => {});
  }

  // ---- The kernel ----

  /** The kernel, started first if needed (asking which one when it isn't clear). */
  async ensureKernel(): Promise<KernelSession | null> {
    if (this.kernel && this.kernel.status !== 'dead') return this.kernel;
    if (this.kernel) {
      try {
        await this.kernel.start();
        return this.kernel;
      } catch (err) {
        notify('error', `${this.kernel.choice.label} didn't start.`, { detail: errorMessage(err) });
        return null;
      }
    }
    const choice = await this.pickKernel(false);
    return choice ? this.startKernel(choice) : null;
  }

  /** The kernel picker (status bar, toolbar). */
  async selectKernel() {
    rescanKernels();
    const choice = await this.pickKernel(true);
    if (choice) await this.startKernel(choice);
  }

  private pickKernel(always: boolean): Promise<KernelChoice | null> {
    return pickKernel({
      wanted: record(this.notebook.metadata.kernelspec).name,
      always,
      placeholder: 'Kernel to run this notebook with',
    });
  }

  private async startKernel(choice: KernelChoice): Promise<KernelSession | null> {
    await this.kernel?.shutdown();
    const cwd = this.doc.path ? dirname(this.doc.path) : (useWorkspace.getState().root ?? 'C:\\');
    const kernel = new KernelSession(this.doc.id, choice, cwd);
    this.kernel = kernel;
    this.emit();
    try {
      await kernel.start();
    } catch (err) {
      notify('error', `${choice.label} didn't start.`, { detail: errorMessage(err) });
      return null;
    }
    // Record the kernel in the notebook, as Jupyter does.
    const kernelspec = {
      display_name: choice.specName === 'python3' ? 'Python 3 (ipykernel)' : choice.label,
      language: kernel.language,
      name: choice.specName,
    };
    const languageInfo = record(kernel.info.language_info);
    const metadata = {
      ...this.notebook.metadata,
      kernelspec,
      ...(Object.keys(languageInfo).length ? { language_info: languageInfo } : {}),
    };
    if (JSON.stringify(metadata) !== JSON.stringify(this.notebook.metadata)) {
      this.change({ ...this.notebook, metadata });
    }
    return kernel;
  }

  async interrupt() {
    await this.kernel
      ?.interrupt()
      .catch((err: unknown) =>
        notify('warning', "Couldn't interrupt the kernel.", { detail: errorMessage(err) }),
      );
  }

  async restart() {
    if (!this.kernel) return;
    this.running.clear();
    this.emit();
    try {
      await this.kernel.restart();
    } catch (err) {
      notify('error', "The kernel didn't restart.", { detail: errorMessage(err) });
    }
    this.emit();
  }

  async restartAndRunAll() {
    await this.restart();
    await this.runAll();
  }

  dispose() {
    this.flush();
    this.stopWatching();
    void this.kernel?.shutdown();
    this.kernel = null;
  }
}

const open = new Map<string, NotebookDoc>();

export function notebookFor(doc: TextDoc): NotebookDoc {
  let nb = open.get(doc.id);
  if (!nb) {
    nb = new NotebookDoc(doc);
    open.set(doc.id, nb);
  }
  return nb;
}

export function openNotebook(docId: string): NotebookDoc | undefined {
  return open.get(docId);
}

/** Shuts the kernel down once the notebook's document is closed. */
export function releaseNotebookSoon(docId: string) {
  setTimeout(() => {
    const nb = open.get(docId);
    if (nb && !getDocument(docId)) {
      nb.dispose();
      open.delete(docId);
    }
  }, 0);
}

/** Before saving a notebook, its latest cells go into the text. */
export function flushNotebook(doc: TextDoc) {
  open.get(doc.id)?.flush();
}

addSaveParticipant(async (doc) => flushNotebook(doc));

export function isNotebookPath(path: string | null | undefined): boolean {
  return !!path && /\.ipynb$/i.test(path);
}

/** Puts the keyboard in a cell: its editor when editing, else the cell itself. */
export function focusCell(nb: NotebookDoc, key: string) {
  const focus = (): boolean => {
    if (nb.editing === key) {
      const view = nb.views.get(key);
      if (view) {
        view.focus();
        return true;
      }
      return false;
    }
    const cell = document.querySelector<HTMLElement>(`[data-cell="${key}"]`);
    cell?.focus();
    return !!cell;
  };
  // At once when the cell is already on screen (so the next key goes to it), else once it is.
  if (!focus()) requestAnimationFrame(() => void focus());
}
