// What the debugger knows: your breakpoints and watch expressions (saved with the session), the
// running debug sessions with their threads and call stacks, the frame you're looking at, and the
// debug console's lines. Live protocol objects stay in debug/manager.ts; this is plain data.

import { create } from 'zustand';
import { newId } from '../lib/events';
import { pathKey } from '../lib/paths';

/** A launch configuration (launch.json, or one Lathe makes for "Debug this file"). */
export interface LaunchConfig {
  type: string;
  request: string;
  name: string;
  [key: string]: unknown;
}

export interface Breakpoint {
  id: string;
  path: string;
  /** 1-based. */
  line: number;
  enabled: boolean;
  /** Stop only when this expression is true. */
  condition?: string;
  /** Stop only on some hits ("5", ">= 3", "% 2"; the adapter decides what it accepts). */
  hitCondition?: string;
  /** A logpoint: print this (with {expressions}) instead of stopping. */
  logMessage?: string;
  /** What the adapter said: whether it could set it, and why not. Unset with no session. */
  verified?: boolean;
  message?: string;
}

export interface StackFrame {
  id: number;
  name: string;
  path: string | null;
  /** The adapter's own id for sources without a file (0 for files). */
  sourceReference: number;
  sourceName: string | null;
  line: number;
  column: number;
  /** Library frames are dimmed; labels are separators ("[Async]"). */
  hint: 'normal' | 'label' | 'subtle';
}

export interface ThreadInfo {
  id: number;
  name: string;
  /** Set while it's paused: why, and its frames (top first). */
  stopped: { reason: string; description?: string; text?: string } | null;
  frames: StackFrame[];
}

export type SessionStatus = 'starting' | 'running' | 'stopped' | 'ended';

export interface ExceptionFilter {
  filter: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  /** The adapter's id ("debugpy", "js-debug", "codelldb", or your own). */
  adapter: string;
  parentId: string | null;
  status: SessionStatus;
  threads: ThreadInfo[];
  exceptionFilters: ExceptionFilter[];
  supports: {
    setVariable: boolean;
    completions: boolean;
    conditions: boolean;
    hitConditions: boolean;
    logPoints: boolean;
  };
}

export interface ConsoleEntry {
  id: number;
  kind: 'output' | 'input' | 'result' | 'error' | 'info';
  /** For output: stdout, stderr, console, important. */
  category?: string;
  text: string;
  /** A result with children (expanded lazily). */
  variablesReference?: number;
  sessionId?: string;
}

export interface Focus {
  sessionId: string;
  threadId: number | null;
  frameId: number | null;
}

export interface Watch {
  id: string;
  expression: string;
}

interface DebugState {
  breakpoints: Breakpoint[];
  /** Breakpoints can all be switched off at once without losing them. */
  breakpointsActive: boolean;
  /** Exception filters switched on, by adapter id (missing: the adapter's defaults). */
  exceptionFilters: Record<string, string[]>;
  watches: Watch[];
  sessions: SessionInfo[];
  focus: Focus | null;
  /** Bumped when values may have changed (a stop, a step, a changed variable). */
  epoch: number;
  console: ConsoleEntry[];
  /** The launch configuration picked in Run and debug, by name. */
  selectedConfig: string | null;
}

export const useDebug = create<DebugState>(() => ({
  breakpoints: [],
  breakpointsActive: true,
  exceptionFilters: {},
  watches: [],
  sessions: [],
  focus: null,
  epoch: 0,
  console: [],
  selectedConfig: null,
}));

// ---- Breakpoints ----

export function breakpointsIn(path: string): Breakpoint[] {
  const key = pathKey(path);
  return useDebug.getState().breakpoints.filter((b) => pathKey(b.path) === key);
}

export function breakpointAt(path: string, line: number): Breakpoint | undefined {
  return breakpointsIn(path).find((b) => b.line === line);
}

/** Adds a breakpoint, or changes the one already on that line. */
export function setBreakpoint(
  path: string,
  line: number,
  options: Pick<Breakpoint, 'condition' | 'hitCondition' | 'logMessage'> = {},
): Breakpoint {
  const existing = breakpointAt(path, line);
  if (existing) {
    updateBreakpoint(existing.id, { ...options, enabled: true });
    return { ...existing, ...options, enabled: true };
  }
  const bp: Breakpoint = { id: newId(), path, line, enabled: true, ...clean(options) };
  useDebug.setState((s) => ({ breakpoints: [...s.breakpoints, bp] }));
  return bp;
}

/** Drops empty strings so "no condition" is one thing. */
function clean<T extends Partial<Breakpoint>>(options: T): T {
  const out = { ...options };
  for (const key of ['condition', 'hitCondition', 'logMessage'] as const) {
    if (key in out && !out[key]?.trim()) delete out[key];
  }
  return out;
}

/** F9 and a click in the gutter: adds a breakpoint, or removes the one there. */
export function toggleBreakpoint(path: string, line: number) {
  const existing = breakpointAt(path, line);
  if (existing) removeBreakpoint(existing.id);
  else setBreakpoint(path, line);
}

export function updateBreakpoint(id: string, patch: Partial<Breakpoint>) {
  useDebug.setState((s) => ({
    breakpoints: s.breakpoints.map((b) => {
      if (b.id !== id) return b;
      const next = { ...b, ...patch };
      for (const key of ['condition', 'hitCondition', 'logMessage'] as const) {
        if (key in patch && !patch[key]?.trim()) delete next[key];
      }
      return next;
    }),
  }));
}

export function removeBreakpoint(id: string) {
  useDebug.setState((s) => ({ breakpoints: s.breakpoints.filter((b) => b.id !== id) }));
}

export function removeAllBreakpoints() {
  useDebug.setState({ breakpoints: [] });
}

export function setAllBreakpointsEnabled(enabled: boolean) {
  useDebug.setState((s) => ({ breakpoints: s.breakpoints.map((b) => ({ ...b, enabled })) }));
}

/** Edits moved breakpoints to other lines; two that land on one line become one. */
export function moveBreakpoints(moves: Map<string, number>) {
  if (!moves.size) return;
  useDebug.setState((s) => {
    const seen = new Set<string>();
    const breakpoints: Breakpoint[] = [];
    for (const b of s.breakpoints) {
      const line = moves.get(b.id) ?? b.line;
      const key = `${pathKey(b.path)}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      breakpoints.push(line === b.line ? b : { ...b, line });
    }
    return { breakpoints };
  });
}

/** What the adapters said about breakpoints, by id. */
export function markBreakpoints(results: Map<string, { verified: boolean; message?: string }>) {
  if (!results.size) return;
  useDebug.setState((s) => ({
    breakpoints: s.breakpoints.map((b) => {
      const result = results.get(b.id);
      if (!result || (result.verified === b.verified && result.message === b.message)) return b;
      return { ...b, verified: result.verified, message: result.message };
    }),
  }));
}

/** With no session left, nothing is verified or not. */
export function forgetVerification() {
  useDebug.setState((s) => ({
    breakpoints: s.breakpoints.map((b) =>
      b.verified === undefined && b.message === undefined
        ? b
        : { ...b, verified: undefined, message: undefined },
    ),
  }));
}

/** What a file's breakpoints ask the adapter for (verification left out). */
export function breakpointSignature(b: Breakpoint): string {
  return [b.line, b.enabled, b.condition, b.hitCondition, b.logMessage].join('\u0000');
}

// ---- Watches ----

export function addWatch(expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) return;
  useDebug.setState((s) => ({ watches: [...s.watches, { id: newId(), expression: trimmed }] }));
}

export function editWatch(id: string, expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) {
    removeWatch(id);
    return;
  }
  useDebug.setState((s) => ({
    watches: s.watches.map((w) => (w.id === id ? { ...w, expression: trimmed } : w)),
  }));
}

export function removeWatch(id: string) {
  useDebug.setState((s) => ({ watches: s.watches.filter((w) => w.id !== id) }));
}

export function removeAllWatches() {
  useDebug.setState({ watches: [] });
}

// ---- Sessions ----

export function sessionInfo(id: string): SessionInfo | undefined {
  return useDebug.getState().sessions.find((s) => s.id === id);
}

export function addSession(info: SessionInfo) {
  useDebug.setState((s) => ({ sessions: [...s.sessions, info] }));
}

export function patchSession(id: string, patch: Partial<SessionInfo>) {
  useDebug.setState((s) => ({
    sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)),
  }));
}

export function removeSession(id: string) {
  useDebug.setState((s) => {
    const sessions = s.sessions.filter((x) => x.id !== id);
    let focus = s.focus;
    if (focus?.sessionId === id) {
      // Look at another paused session, if there is one.
      const next = sessions.find((x) => x.status === 'stopped') ?? sessions[0];
      const thread = next?.threads.find((t) => t.stopped);
      focus = next
        ? {
            sessionId: next.id,
            threadId: thread?.id ?? null,
            frameId: thread?.frames[0]?.id ?? null,
          }
        : null;
    }
    return { sessions, focus };
  });
}

export function setFocus(focus: Focus | null) {
  useDebug.setState({ focus });
}

export function bumpEpoch() {
  useDebug.setState((s) => ({ epoch: s.epoch + 1 }));
}

/** The frame you're looking at, and the thread and session it's in. */
export function focusedFrame(): {
  session: SessionInfo;
  thread: ThreadInfo | null;
  frame: StackFrame | null;
} | null {
  const { focus, sessions } = useDebug.getState();
  if (!focus) return null;
  const session = sessions.find((s) => s.id === focus.sessionId);
  if (!session) return null;
  const thread = session.threads.find((t) => t.id === focus.threadId) ?? null;
  const frame = thread?.frames.find((f) => f.id === focus.frameId) ?? null;
  return { session, thread, frame };
}

/** "running" or "stopped" for the session you're looking at; "inactive" with none. */
export function debugStateOf(state: DebugState): 'inactive' | 'running' | 'stopped' {
  if (!state.sessions.length) return 'inactive';
  const focused = state.sessions.find((s) => s.id === state.focus?.sessionId);
  if (focused) return focused.status === 'stopped' ? 'stopped' : 'running';
  return state.sessions.some((s) => s.status === 'stopped') ? 'stopped' : 'running';
}

// ---- Debug console ----

const MAX_CONSOLE = 5000;
let consoleId = 0;

/** Adds console output. Programs write in pieces, so text joins the line it continues. */
export function appendConsole(entry: Omit<ConsoleEntry, 'id'>) {
  useDebug.setState((s) => {
    const last = s.console.at(-1);
    if (
      entry.kind === 'output' &&
      last?.kind === 'output' &&
      last.category === entry.category &&
      last.sessionId === entry.sessionId &&
      !last.variablesReference &&
      !entry.variablesReference &&
      !last.text.endsWith('\n')
    ) {
      const joined = { ...last, text: last.text + entry.text };
      return { console: [...s.console.slice(0, -1), joined] };
    }
    const next = [...s.console, { ...entry, id: ++consoleId }];
    return { console: next.length > MAX_CONSOLE ? next.slice(-MAX_CONSOLE) : next };
  });
}

export function clearConsole() {
  useDebug.setState({ console: [] });
}

// ---- Saved with the session ----

export interface SavedDebug {
  breakpoints: Omit<Breakpoint, 'verified' | 'message'>[];
  breakpointsActive: boolean;
  exceptionFilters: Record<string, string[]>;
  watches: string[];
  selectedConfig: string | null;
}

export function debugSnapshot(): SavedDebug {
  const s = useDebug.getState();
  return {
    breakpoints: s.breakpoints.map((b) => {
      const saved = { ...b };
      delete saved.verified;
      delete saved.message;
      return saved;
    }),
    breakpointsActive: s.breakpointsActive,
    exceptionFilters: s.exceptionFilters,
    watches: s.watches.map((w) => w.expression),
    selectedConfig: s.selectedConfig,
  };
}

export function restoreDebug(saved: Partial<SavedDebug> | undefined) {
  if (!saved) return;
  const breakpoints = (saved.breakpoints ?? []).filter(
    (b) => typeof b?.path === 'string' && Number.isInteger(b.line) && b.line > 0,
  );
  useDebug.setState({
    breakpoints: breakpoints.map((b) => ({
      ...b,
      id: b.id || newId(),
      enabled: b.enabled !== false,
    })),
    breakpointsActive: saved.breakpointsActive !== false,
    exceptionFilters:
      saved.exceptionFilters && typeof saved.exceptionFilters === 'object'
        ? saved.exceptionFilters
        : {},
    watches: (saved.watches ?? [])
      .filter((w): w is string => typeof w === 'string' && !!w.trim())
      .map((expression) => ({ id: newId(), expression })),
    selectedConfig: typeof saved.selectedConfig === 'string' ? saved.selectedConfig : null,
  });
}

/** True when the persistent parts changed (for the session autosave). */
export function persistentChanged(next: DebugState, prev: DebugState): boolean {
  return (
    next.breakpoints !== prev.breakpoints ||
    next.breakpointsActive !== prev.breakpointsActive ||
    next.exceptionFilters !== prev.exceptionFilters ||
    next.watches !== prev.watches ||
    next.selectedConfig !== prev.selectedConfig
  );
}

export type { DebugState };
