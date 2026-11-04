// Terminals in the panel: shells you open, and the terminals the Run button and tasks reuse.
// The store holds each terminal's one connection to Rust. Views come and go as the panel
// changes, but output, exits and problem matching keep flowing while nothing is on screen.

import { create } from 'zustand';
import { type TerminalEvent, type TerminalInfo, backend, errorMessage } from '../../lib/backend';
import { notify } from '../../services/notifications';
import { showPanel, useLayout } from '../layout';
import { useWorkspace } from '../workspaceStore';

interface TerminalState {
  terminals: TerminalInfo[];
  active: string | null;
}

export const useTerminals = create<TerminalState>(() => ({ terminals: [], active: null }));

/** A first guess at the size; the view resizes the terminal as soon as it's on screen. */
const SIZE = { cols: 120, rows: 24 };

/** Output kept per terminal for a view that opens later (xterm keeps 10,000 lines itself). */
const MAX_TEXT = 1_000_000;

interface Stream {
  text: string;
  exit: { code: number | null } | null;
  listeners: Set<(event: TerminalEvent) => void>;
  waiters: Array<(code: number | null) => void>;
}

const streams = new Map<string, Stream>();

function connect(info: TerminalInfo) {
  const stream: Stream = { text: '', exit: null, listeners: new Set(), waiters: [] };
  streams.set(info.id, stream);
  const emit = (event: TerminalEvent) => {
    for (const listener of stream.listeners) listener(event);
  };
  void backend()
    .terminal.attach(info.id, (event) => {
      if (event.type === 'output') {
        stream.text += event.data;
        if (stream.text.length > MAX_TEXT) {
          const from = stream.text.length - MAX_TEXT;
          const cut = stream.text.indexOf('\n', from);
          stream.text = stream.text.slice(cut >= 0 ? cut + 1 : from);
        }
      } else {
        stream.exit = { code: event.code };
        markExited(info.id, event.code);
        for (const resolve of stream.waiters.splice(0)) resolve(event.code);
      }
      emit(event);
    })
    .catch((err: unknown) => {
      const event: TerminalEvent = {
        type: 'output',
        data: `\x1b[31m${errorMessage(err)}\x1b[0m\r\n`,
      };
      stream.text += event.data;
      emit(event);
    });
}

/** Sends a terminal's events to `listener`, starting with everything it has shown so far. */
export function watchTerminal(id: string, listener: (event: TerminalEvent) => void): () => void {
  const stream = streams.get(id);
  if (!stream) return () => {};
  if (stream.text) listener({ type: 'output', data: stream.text });
  if (stream.exit) listener({ type: 'exit', code: stream.exit.code });
  stream.listeners.add(listener);
  return () => stream.listeners.delete(listener);
}

/** Resolves when the terminal's program exits (or the terminal is closed), with its output. */
export function terminalExited(id: string): Promise<{ code: number | null; text: string }> {
  const stream = streams.get(id);
  if (!stream) return Promise.resolve({ code: null, text: '' });
  if (stream.exit) return Promise.resolve({ code: stream.exit.code, text: stream.text });
  return new Promise((resolve) =>
    stream.waiters.push((code) => resolve({ code, text: stream.text })),
  );
}

function add(info: TerminalInfo) {
  connect(info);
  useTerminals.setState((s) => ({ terminals: [...s.terminals, info], active: info.id }));
  showPanel('terminal');
}

export async function newTerminal(profile?: string, cwd?: string): Promise<TerminalInfo | null> {
  const root = useWorkspace.getState().root ?? undefined;
  try {
    const info = await backend().terminal.open({ profile, cwd: cwd ?? root, ...SIZE });
    add(info);
    return info;
  } catch (err) {
    notify('error', "Couldn't start the terminal.", { detail: errorMessage(err) });
    return null;
  }
}

/** Runs a program in a terminal tagged `tag`, replacing that tag's previous terminal. */
export async function runInTerminal(options: {
  title: string;
  program: string;
  args: string[];
  cwd: string;
  env: [string, string][];
  tag: string;
}): Promise<TerminalInfo | null> {
  const previous = useTerminals.getState().terminals.filter((t) => t.tag === options.tag);
  for (const old of previous) await closeTerminal(old.id);
  try {
    const info = await backend().terminal.run({ ...options, ...SIZE });
    add(info);
    return info;
  } catch (err) {
    notify('error', `Couldn't start ${options.program}.`, { detail: errorMessage(err) });
    return null;
  }
}

export async function closeTerminal(id: string) {
  await backend()
    .terminal.close(id)
    .catch(() => {});
  const stream = streams.get(id);
  streams.delete(id);
  for (const resolve of stream?.waiters.splice(0) ?? []) resolve(null);
  useTerminals.setState((s) => {
    const terminals = s.terminals.filter((t) => t.id !== id);
    const active = s.active === id ? (terminals.at(-1)?.id ?? null) : s.active;
    return { terminals, active };
  });
}

function markExited(id: string, code: number | null) {
  useTerminals.setState((s) => ({
    terminals: s.terminals.map((t) => (t.id === id ? { ...t, running: false, exitCode: code } : t)),
  }));
}

export function setActiveTerminal(id: string) {
  useTerminals.setState({ active: id });
}

/** Ctrl+`: shows the terminal panel (starting a shell if there's none) or hides it. */
export async function toggleTerminal() {
  const layout = useLayout.getState();
  if (layout.panelVisible && layout.panel === 'terminal') {
    useLayout.setState({ panelVisible: false });
    return;
  }
  showPanel('terminal');
  if (!useTerminals.getState().terminals.length) await newTerminal();
  requestAnimationFrame(() =>
    document
      .querySelector<HTMLElement>('[data-terminal-active="true"] .xterm-helper-textarea')
      ?.focus(),
  );
}
