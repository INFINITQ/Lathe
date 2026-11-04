// Running debug sessions. Starting one: trust, saving, the preLaunchTask, downloading the adapter
// the first time, and connecting to it the way it wants. Then what the adapter tells us (stops,
// output, breakpoint changes) and what you ask of it (stepping, variables, evaluating), and at
// the end, stopping everything the session started.

import { dirtyDocuments, saveDocument, type TextDoc } from '../editor/documents';
import { plainText } from '../lib/ansi';
import { backend, errorMessage } from '../lib/backend';
import { newId } from '../lib/events';
import { basename, dirname, isUnder, pathKey } from '../lib/paths';
import { ensureTrusted } from '../run/run';
import { loadTasks, runTask, substitute } from '../run/tasks';
import { setContext } from '../services/context';
import { ask } from '../services/dialogs';
import { dismiss, notify } from '../services/notifications';
import { appendOutput, useOutput } from '../services/output';
import { getSetting } from '../services/settings';
import { activeTab, openPath } from '../workbench/editors/store';
import { showPanel, showView } from '../workbench/layout';
import { runInTerminal } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { type AdapterDef, adapterFor } from './adapters';
import { fileConfiguration, loadConfigurations } from './launch';
import { DebugSession, type SessionHandlers } from './session';
import {
  type Breakpoint,
  type DebugState,
  type ExceptionFilter,
  type LaunchConfig,
  type SessionInfo,
  type StackFrame,
  type ThreadInfo,
  addSession,
  appendConsole,
  breakpointSignature,
  bumpEpoch,
  debugStateOf,
  forgetVerification,
  markBreakpoints,
  patchSession,
  removeSession,
  sessionInfo,
  setFocus,
  useDebug,
} from './store';

/** The selected configuration value that means "the active file". */
export const ACTIVE_FILE = ':file';

interface Live {
  session: DebugSession;
  adapter: AdapterDef;
  request: 'launch' | 'attach';
  folder: string;
  /** Starts this session again (root sessions; children come back with their parent). */
  restart: (() => Promise<unknown>) | null;
  /** js-debug's server port; its child sessions connect to it as well. */
  port: number | null;
  /** Stops what the session started: the adapter process, its connection. */
  cleanup: (() => void)[];
  /** The adapter's breakpoint ids, mapped to ours (for `breakpoint` events). */
  breakpointIds: Map<number, string>;
  /** What this session says about each of our breakpoints. */
  verified: Map<string, { verified: boolean; message?: string }>;
  terminalTag: string;
  configured: boolean;
  stopping: boolean;
  finished: boolean;
}

const live = new Map<string, Live>();
/** The exception filters each adapter offered, so Breakpoints can show them between sessions. */
const knownFilters = new Map<string, ExceptionFilter[]>();
let consoleOpened = false;

export function exceptionFiltersOf(adapterId: string): ExceptionFilter[] {
  return knownFilters.get(adapterId) ?? [];
}

export function knownAdapters(): string[] {
  return [...knownFilters.keys()];
}

function log(entry: Live, line: string) {
  appendOutput(`Debug: ${entry.adapter.name}`, `${line}\n`);
}

function showAdapterLog(entry: Live) {
  useOutput.setState({ active: `Debug: ${entry.adapter.name}` });
  showPanel('output');
}

function supportsOf(c: Record<string, unknown>): SessionInfo['supports'] {
  return {
    setVariable: c.supportsSetVariable === true,
    completions: c.supportsCompletionsRequest === true,
    conditions: c.supportsConditionalBreakpoints === true,
    hitConditions: c.supportsHitConditionalBreakpoints === true,
    logPoints: c.supportsLogPoints === true,
  };
}

/** Fills ${workspaceFolder}, ${file} and the rest into every string of a configuration. */
function substituteConfig(config: LaunchConfig, root: string): LaunchConfig {
  const ctx = { root, file: activeTab().doc?.path ?? null, shell: null };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return substitute(value, ctx);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(config) as LaunchConfig;
}

/** The folder a session belongs to: the open folder, or the active file's. */
function debugFolder(path?: string | null): string | null {
  const root = useWorkspace.getState().root;
  const file = path ?? activeTab().doc?.path ?? null;
  if (root && (!file || isUnder(file, root))) return root;
  return file ? dirname(file) : root;
}

async function saveBeforeStart() {
  for (const doc of dirtyDocuments()) {
    if (doc.path) await saveDocument(doc);
  }
}

async function runPreLaunchTask(label: string, root: string): Promise<boolean> {
  const task = (await loadTasks(root)).find((t) => t.label === label);
  if (!task) {
    notify('error', `There's no task called "${label}" to run before debugging.`, {
      detail: 'Add it to .lathe/tasks.json, or change "preLaunchTask".',
    });
    return false;
  }
  const code = await runTask(task);
  if (code === 0) return true;
  notify('error', `The task "${label}" failed${code === null ? '' : ` (exit code ${code})`}.`, {
    detail: "Debugging didn't start. The terminal shows what happened.",
  });
  return false;
}

/** The adapter's folder, downloading it first (after asking) if it isn't there yet. */
async function ensureAdapter(adapter: AdapterDef): Promise<string | null> {
  const tools = await backend().lsp.toolsDir();
  const found = await adapter.locate(tools);
  if (found) return found;
  const install = adapter.install;
  if (!install) {
    notify('error', `${adapter.name} isn't installed.`);
    return null;
  }
  const answer = await ask({
    title: `Download ${adapter.name}?`,
    message: `Debugging needs ${adapter.name} (about ${install.size}). Lathe downloads it from ${new URL(install.url).host}, checks its SHA-256, and keeps it in its own tools folder.`,
    buttons: [
      { id: 'download', label: 'Download', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'download') return null;
  const toast = notify('info', `Downloading ${adapter.name} (about ${install.size})…`, {
    timeout: 0,
  });
  try {
    if (!(await backend().fs.stat(tools))) await backend().fs.createDir(tools);
    await backend().lsp.installArchive(install.name, install.url, install.sha256);
  } catch (err) {
    notify('error', `Couldn't download ${adapter.name}.`, { detail: errorMessage(err) });
    return null;
  } finally {
    dismiss(toast);
  }
  return adapter.locate(tools);
}

/** Starts debugging with a configuration (from launch.json, or made for a file). */
export async function startDebugging(
  config: LaunchConfig,
  options: {
    restart?: () => Promise<unknown>;
    trusted?: boolean;
    /** The folder it belongs to (default: the open folder, or the active file's). */
    folder?: string;
  } = {},
): Promise<boolean> {
  // Not from the program: launch.json's ${workspaceFolder} isn't filled in yet.
  const folder = options.folder ?? debugFolder();
  if (!folder) {
    notify('info', 'Open a folder or a file to debug it.');
    return false;
  }
  if (!options.trusted && !(await ensureTrusted(folder))) return false;
  await saveBeforeStart();
  let resolved = substituteConfig(config, folder);
  if (typeof resolved.preLaunchTask === 'string' && resolved.preLaunchTask) {
    if (!(await runPreLaunchTask(resolved.preLaunchTask, folder))) return false;
  }
  const adapter = adapterFor(resolved.type);
  if (!adapter) {
    notify('error', `Lathe has no debugger for "${resolved.type}" configurations.`, {
      detail:
        'Use debugpy (Python), node (JavaScript and TypeScript) or lldb (C, C++ and Rust), or add your own under "debug.adapters" in settings.',
    });
    return false;
  }
  const dir = await ensureAdapter(adapter);
  if (!dir) return false;
  if (typeof resolved.cwd !== 'string' || !resolved.cwd) resolved = { ...resolved, cwd: folder };
  const filled = await adapter.resolve(resolved);
  if (typeof filled === 'string') {
    notify('warning', filled, {
      actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
    });
    return false;
  }
  return launchSession({
    adapter,
    dir,
    config: filled,
    request: filled.request === 'attach' ? 'attach' : 'launch',
    name: filled.name,
    folder,
    restart: options.restart ?? (() => startDebugging(config, { trusted: true })),
    parent: null,
  });
}

function openConsoleOnStart(config: LaunchConfig) {
  // A program in a terminal shows the terminal instead.
  if (config.console === 'integratedTerminal' || config.terminal === 'integrated') return;
  const when = getSetting('debug.openDebugConsole');
  if (when === 'neverOpen' || (when === 'openOnFirstSessionStart' && consoleOpened)) return;
  consoleOpened = true;
  showPanel('debugConsole');
}

async function launchSession(options: {
  adapter: AdapterDef;
  dir: string;
  config: LaunchConfig;
  request: 'launch' | 'attach';
  name: string;
  folder: string;
  restart: (() => Promise<unknown>) | null;
  parent: Live | null;
}): Promise<boolean> {
  const { adapter, config, parent } = options;
  const id = newId();
  const session = new DebugSession(
    id,
    options.name,
    String(config.type ?? adapter.id),
    config,
    handlers,
    parent?.session ?? null,
  );
  const entry: Live = {
    session,
    adapter,
    request: options.request,
    folder: options.folder,
    restart: options.restart,
    port: parent?.port ?? null,
    cleanup: [],
    breakpointIds: new Map(),
    verified: new Map(),
    terminalTag: parent?.terminalTag ?? `debug:${options.name}`,
    configured: false,
    stopping: false,
    finished: false,
  };
  live.set(id, entry);
  addSession({
    id,
    name: options.name,
    adapter: adapter.id,
    parentId: parent?.session.id ?? null,
    status: 'starting',
    threads: [],
    exceptionFilters: [],
    supports: supportsOf({}),
  });
  if (!parent) openConsoleOnStart(config);
  try {
    await connectAdapter(entry, options.dir, parent);
    await session.start(options.request, () => configure(entry));
    if (sessionInfo(id)?.status === 'starting') patchSession(id, { status: 'running' });
    return true;
  } catch (err) {
    if (!entry.stopping) {
      notify('error', `${options.name} didn't start.`, {
        detail: errorMessage(err),
        actions: [{ label: 'Show the adapter log', run: () => showAdapterLog(entry) }],
      });
    }
    await session.stop(true).catch(() => {});
    finish(entry);
    return false;
  }
}

async function connectAdapter(entry: Live, dir: string, parent: Live | null) {
  const { session } = entry;
  const adopt = (connection: string) =>
    session.attach({
      id: connection,
      close: () =>
        void backend()
          .debug.close(connection)
          .catch(() => {}),
    });
  // js-debug's child sessions: another connection to the same server.
  if (parent?.port) {
    adopt(await backend().debug.connect(parent.port, session.onEvent));
    return;
  }
  const transport = await entry.adapter.transport(dir, session.configuration as LaunchConfig);
  if (typeof transport === 'string') throw new Error(transport);
  const stopProcess = (pid: string) =>
    entry.cleanup.push(
      () =>
        void backend()
          .debug.close(pid)
          .catch(() => {}),
    );

  if (transport.kind === 'stdio') {
    const { id } = await backend().debug.spawn(
      { ...transport.launch, stdio: true },
      session.onEvent,
    );
    adopt(id);
    return;
  }

  if (transport.kind === 'server') {
    let found: (port: number) => void = () => {};
    let failed: (err: Error) => void = () => {};
    const port = new Promise<number>((resolve, reject) => {
      found = resolve;
      failed = reject;
    });
    const { id: pid } = await backend().debug.spawn(
      { ...transport.launch, stdio: false },
      (event) => {
        if (event.type === 'log') {
          log(entry, event.line);
          const match = transport.port.exec(event.line);
          if (match) found(Number(match[1]));
        } else if (event.type === 'exit') {
          log(entry, `[lathe] the adapter exited (code ${event.code ?? 'unknown'})`);
          failed(new Error('The debug adapter stopped before it was ready.'));
        }
      },
    );
    stopProcess(pid);
    const timer = setTimeout(
      () => failed(new Error("The debug adapter didn't start its server.")),
      15_000,
    );
    try {
      entry.port = await port;
    } finally {
      clearTimeout(timer);
    }
    adopt(await backend().debug.connect(entry.port, session.onEvent));
    return;
  }

  // The adapter connects back to a port Lathe opens.
  const listening = await backend().debug.listen();
  const { id: pid } = await backend().debug.spawn(
    { ...transport.launch(listening.port), stdio: false },
    (event) => {
      if (event.type === 'log') log(entry, event.line);
      else if (event.type === 'exit')
        log(entry, `[lathe] the adapter exited (code ${event.code ?? 'unknown'})`);
    },
  );
  stopProcess(pid);
  await backend().debug.accept(listening.id, session.onEvent);
  adopt(listening.id);
}

// ---- Breakpoints ----

interface DapBreakpoint {
  id?: number;
  verified?: boolean;
  message?: string;
  line?: number;
}

/** Our breakpoints' state: verified if any session could set them. */
function settle(ids: Iterable<string>) {
  const results = new Map<string, { verified: boolean; message?: string }>();
  for (const id of ids) {
    let verified = false;
    let message: string | undefined;
    let known = false;
    for (const entry of live.values()) {
      const said = entry.verified.get(id);
      if (!said) continue;
      known = true;
      if (said.verified) verified = true;
      else message ??= said.message;
    }
    if (known) results.set(id, { verified, message: verified ? undefined : message });
  }
  markBreakpoints(results);
}

async function sendBreakpoints(entry: Live, path: string, list: Breakpoint[]) {
  try {
    const body = await entry.session.request<{ breakpoints?: DapBreakpoint[] }>('setBreakpoints', {
      source: { path, name: basename(path) },
      breakpoints: list.map((b) => ({
        line: b.line,
        ...(b.condition ? { condition: b.condition } : {}),
        ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
        ...(b.logMessage ? { logMessage: b.logMessage } : {}),
      })),
      lines: list.map((b) => b.line),
      sourceModified: false,
    });
    (body.breakpoints ?? []).forEach((bp, i) => {
      const ours = list[i];
      if (!ours) return;
      if (typeof bp.id === 'number') entry.breakpointIds.set(bp.id, ours.id);
      entry.verified.set(ours.id, { verified: bp.verified !== false, message: bp.message });
    });
  } catch (err) {
    for (const b of list) entry.verified.set(b.id, { verified: false, message: errorMessage(err) });
  }
  settle(list.map((b) => b.id));
}

/** Each file's breakpoints that should be set, and a signature to spot changes. */
function filesOf(
  state: DebugState,
): Map<string, { path: string; sig: string; list: Breakpoint[] }> {
  const files = new Map<string, { path: string; sig: string; list: Breakpoint[] }>();
  for (const b of state.breakpoints) {
    const key = pathKey(b.path);
    let file = files.get(key);
    if (!file) {
      file = { path: b.path, sig: String(state.breakpointsActive), list: [] };
      files.set(key, file);
    }
    file.sig += `\n${breakpointSignature(b)}`;
    if (b.enabled && state.breakpointsActive) file.list.push(b);
  }
  return files;
}

async function sendExceptionFilters(entry: Live) {
  const filters = sessionInfo(entry.session.id)?.exceptionFilters ?? [];
  if (!filters.length) return;
  const chosen =
    useDebug.getState().exceptionFilters[entry.adapter.id] ??
    filters.filter((f) => f.default).map((f) => f.filter);
  await entry.session
    .request('setExceptionBreakpoints', {
      filters: chosen.filter((id) => filters.some((f) => f.filter === id)),
    })
    .catch((err: unknown) => log(entry, `[lathe] setExceptionBreakpoints: ${errorMessage(err)}`));
}

/** Switches an exception filter ("Uncaught exceptions"…) on or off for an adapter. */
export function setExceptionFilter(adapterId: string, filter: string, on: boolean) {
  const defaults = exceptionFiltersOf(adapterId)
    .filter((f) => f.default)
    .map((f) => f.filter);
  useDebug.setState((s) => {
    const current = s.exceptionFilters[adapterId] ?? defaults;
    const next = on ? [...new Set([...current, filter])] : current.filter((f) => f !== filter);
    return { exceptionFilters: { ...s.exceptionFilters, [adapterId]: next } };
  });
  for (const entry of live.values()) {
    if (entry.adapter.id === adapterId && entry.configured) void sendExceptionFilters(entry);
  }
}

/** Sent while the session starts: every breakpoint, then the exception filters. */
async function configure(entry: Live) {
  const { session } = entry;
  const caps = session.capabilities;
  const filters = Array.isArray(caps.exceptionBreakpointFilters)
    ? (caps.exceptionBreakpointFilters as ExceptionFilter[]).filter(
        (f) => typeof f?.filter === 'string',
      )
    : [];
  if (filters.length) knownFilters.set(entry.adapter.id, filters);
  patchSession(session.id, { exceptionFilters: filters, supports: supportsOf(caps) });
  // From here on, changes are sent as they happen.
  entry.configured = true;
  const files = filesOf(useDebug.getState());
  await Promise.all(
    [...files.values()]
      .filter((f) => f.list.length)
      .map((f) => sendBreakpoints(entry, f.path, f.list)),
  );
  await sendExceptionFilters(entry);
}

/** Sends breakpoint changes to the running sessions. Returns the unsubscriber. */
function watchBreakpoints(): () => void {
  return useDebug.subscribe((state, prev) => {
    if (
      !live.size ||
      (state.breakpoints === prev.breakpoints && state.breakpointsActive === prev.breakpointsActive)
    ) {
      return;
    }
    const before = filesOf(prev);
    const after = filesOf(state);
    const changed: { path: string; list: Breakpoint[] }[] = [];
    for (const [key, file] of after) {
      if (before.get(key)?.sig !== file.sig) changed.push(file);
    }
    for (const [key, file] of before) if (!after.has(key)) changed.push({ ...file, list: [] });
    if (!changed.length) return;
    for (const entry of live.values()) {
      if (!entry.configured || entry.session.ended) continue;
      for (const file of changed) void sendBreakpoints(entry, file.path, file.list);
    }
  });
}

// ---- What the adapter tells us ----

const handlers: SessionHandlers = {
  event: (session, event, body) => {
    const entry = live.get(session.id);
    if (entry) onAdapterEvent(entry, event, body);
  },
  runInTerminal: (session, args) => runProgramInTerminal(session, args),
  startDebugging: (session, args) => startChildSession(session, args),
  closed: (session) => {
    const entry = live.get(session.id);
    if (entry) finish(entry);
  },
  log: (session, line) => {
    const entry = live.get(session.id);
    if (entry) log(entry, line);
  },
};

function onAdapterEvent(entry: Live, event: string, body: Record<string, unknown>) {
  const id = entry.session.id;
  switch (event) {
    case 'stopped':
      void onStopped(entry, body);
      break;
    case 'continued':
      resumeThreads(
        entry,
        body.allThreadsContinued === false && typeof body.threadId === 'number'
          ? body.threadId
          : null,
      );
      break;
    case 'thread':
      refreshThreadsSoon(entry);
      break;
    case 'output': {
      const category = typeof body.category === 'string' ? body.category : 'console';
      if (category === 'telemetry') break;
      const text = typeof body.output === 'string' ? plainText(body.output) : '';
      const ref = typeof body.variablesReference === 'number' ? body.variablesReference : 0;
      if (!text && !ref) break;
      appendConsole({
        kind: 'output',
        category,
        text,
        variablesReference: ref || undefined,
        sessionId: id,
      });
      break;
    }
    case 'breakpoint': {
      const bp = body.breakpoint as DapBreakpoint | undefined;
      const ours = typeof bp?.id === 'number' ? entry.breakpointIds.get(bp.id) : undefined;
      if (!bp || !ours) break;
      if (body.reason === 'removed') entry.verified.delete(ours);
      else entry.verified.set(ours, { verified: bp.verified !== false, message: bp.message });
      settle([ours]);
      break;
    }
    case 'terminated':
      void stopEntry(entry, false);
      break;
    case 'exited':
      if (typeof body.exitCode === 'number') {
        appendConsole({
          kind: 'info',
          text: `${entry.session.name} exited with code ${body.exitCode}.\n`,
          sessionId: id,
        });
      }
      break;
    case 'capabilities':
      if (body.capabilities && typeof body.capabilities === 'object') {
        Object.assign(entry.session.capabilities, body.capabilities);
        patchSession(id, { supports: supportsOf(entry.session.capabilities) });
      }
      break;
    case 'invalidated':
      bumpEpoch();
      break;
    default:
      break;
  }
}

interface DapFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  presentationHint?: string;
  source?: { path?: string; name?: string; sourceReference?: number; presentationHint?: string };
}

/** Paths can come back as c:\…; the editor's tabs use C:\…. */
function normalizePath(path: string): string {
  return path.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

async function fetchThreads(entry: Live): Promise<{ id: number; name: string }[]> {
  const body = await entry.session
    .request<{ threads?: { id: number; name: string }[] }>('threads')
    .catch(() => ({ threads: [] }));
  return (body.threads ?? []).filter((t) => typeof t?.id === 'number');
}

async function fetchFrames(entry: Live, threadId: number): Promise<StackFrame[]> {
  const body = await entry.session
    .request<{ stackFrames?: DapFrame[] }>('stackTrace', { threadId, startFrame: 0, levels: 50 })
    .catch(() => ({ stackFrames: [] }));
  return (body.stackFrames ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    path: f.source?.path ? normalizePath(f.source.path) : null,
    sourceReference: f.source?.sourceReference ?? 0,
    sourceName: f.source?.name ?? null,
    line: f.line,
    column: f.column,
    hint:
      f.presentationHint === 'label'
        ? 'label'
        : f.presentationHint === 'subtle' || f.source?.presentationHint === 'deemphasize'
          ? 'subtle'
          : 'normal',
  }));
}

/** The frame to show when a thread stops: the top one, or the first with a file. */
function frameToShow(frames: StackFrame[]): StackFrame | null {
  return frames.slice(0, 8).find((f) => f.path) ?? frames[0] ?? null;
}

function mergeThreads(
  previous: ThreadInfo[],
  threads: { id: number; name: string }[],
): ThreadInfo[] {
  return threads.map((t) => {
    const before = previous.find((p) => p.id === t.id);
    return before
      ? { ...before, name: t.name }
      : { id: t.id, name: t.name, stopped: null, frames: [] };
  });
}

async function onStopped(entry: Live, body: Record<string, unknown>) {
  const id = entry.session.id;
  const threadId = typeof body.threadId === 'number' ? body.threadId : null;
  const stop = {
    reason: typeof body.reason === 'string' ? body.reason : 'pause',
    description: typeof body.description === 'string' ? body.description : undefined,
    text: typeof body.text === 'string' ? body.text : undefined,
  };
  const listed = await fetchThreads(entry);
  if (threadId !== null && !listed.some((t) => t.id === threadId)) {
    listed.push({ id: threadId, name: `Thread ${threadId}` });
  }
  const all = body.allThreadsStopped === true;
  const threads = mergeThreads(sessionInfo(id)?.threads ?? [], listed).map((t) =>
    all || t.id === threadId
      ? { ...t, stopped: stop, frames: t.id === threadId ? [] : t.frames }
      : t,
  );
  const target = threadId ?? threads.find((t) => t.stopped)?.id ?? null;
  const frames = target === null ? [] : await fetchFrames(entry, target);
  if (entry.finished) return;
  const final = threads.map((t) => (t.id === target ? { ...t, frames } : t));
  patchSession(id, { status: 'stopped', threads: final });
  // Look at this stop, unless you're already looking at another paused session.
  const focus = useDebug.getState().focus;
  const elsewhere =
    focus && focus.sessionId !== id && sessionInfo(focus.sessionId)?.status === 'stopped';
  const frame = frameToShow(frames);
  if (!elsewhere && target !== null) {
    setFocus({ sessionId: id, threadId: target, frameId: frame?.id ?? null });
    const focusEditor = getSetting('debug.focusEditorOnBreak') && body.preserveFocusHint !== true;
    if (frame) void revealFrame(frame, focusEditor);
    if (focusEditor && !document.hasFocus()) backend().window.requestAttention();
  }
  bumpEpoch();
}

const threadTimers = new Map<string, ReturnType<typeof setTimeout>>();

function refreshThreadsSoon(entry: Live) {
  const id = entry.session.id;
  clearTimeout(threadTimers.get(id));
  threadTimers.set(
    id,
    setTimeout(() => {
      threadTimers.delete(id);
      void fetchThreads(entry).then((listed) => {
        const info = sessionInfo(id);
        if (info && !entry.finished)
          patchSession(id, { threads: mergeThreads(info.threads, listed) });
      });
    }, 100),
  );
}

/** Threads run again (one, or all with null): their frames and the stopped line go away. */
function resumeThreads(entry: Live, threadId: number | null) {
  const info = sessionInfo(entry.session.id);
  if (!info) return;
  const threads = info.threads.map((t) =>
    threadId === null || t.id === threadId ? { ...t, stopped: null, frames: [] } : t,
  );
  patchSession(entry.session.id, {
    threads,
    status: threads.some((t) => t.stopped) ? 'stopped' : 'running',
  });
  const focus = useDebug.getState().focus;
  if (focus?.sessionId === entry.session.id && (threadId === null || focus.threadId === threadId)) {
    setFocus({ ...focus, frameId: null });
  }
  bumpEpoch();
}

/** Opens a frame's file at its line. */
export async function revealFrame(frame: StackFrame, focusEditor = true) {
  if (!frame.path) return;
  await openPath(frame.path, {
    selection: { line: frame.line, column: Math.max(1, frame.column) },
    preserveFocus: !focusEditor,
  });
}

/** Looks at a frame from the call stack. */
export function selectFrame(sessionId: string, threadId: number, frame: StackFrame) {
  setFocus({ sessionId, threadId, frameId: frame.id });
  void revealFrame(frame);
}

async function runProgramInTerminal(session: DebugSession, args: Record<string, unknown>) {
  const entry = live.get(session.id);
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  const [program, ...rest] = argv;
  if (!program) throw new Error('The debug adapter asked to run nothing.');
  const env: [string, string][] = [];
  if (args.env && typeof args.env === 'object') {
    for (const [key, value] of Object.entries(args.env as Record<string, unknown>)) {
      if (typeof value === 'string') env.push([key, value]);
    }
  }
  const info = await runInTerminal({
    title: typeof args.title === 'string' && args.title ? args.title : `Debug: ${session.name}`,
    program,
    args: rest,
    cwd: typeof args.cwd === 'string' && args.cwd ? args.cwd : (entry?.folder ?? 'C:\\'),
    env,
    tag: entry?.terminalTag ?? `debug:${session.name}`,
  });
  if (!info) throw new Error(`Couldn't start ${basename(program)} in a terminal.`);
}

async function startChildSession(parent: DebugSession, args: Record<string, unknown>) {
  const entry = live.get(parent.id);
  if (!entry || entry.stopping) return;
  const configuration = (args.configuration ?? {}) as LaunchConfig;
  const name = typeof configuration.name === 'string' ? configuration.name : parent.name;
  await launchSession({
    adapter: entry.adapter,
    dir: '',
    // Sent back unchanged, as js-debug expects.
    config: configuration,
    request: args.request === 'attach' ? 'attach' : 'launch',
    name,
    folder: entry.folder,
    restart: null,
    parent: entry,
  });
}

// ---- Ending ----

function childrenOf(entry: Live): Live[] {
  return [...live.values()].filter((e) => e.session.parent === entry.session);
}

function finish(entry: Live) {
  if (entry.finished) return;
  entry.finished = true;
  live.delete(entry.session.id);
  for (const child of childrenOf(entry)) void stopEntry(child, true);
  for (const cleanup of entry.cleanup.splice(0)) cleanup();
  entry.session.connection?.close();
  removeSession(entry.session.id);
  if (live.size) settle(entry.verified.keys());
  else forgetVerification();
  bumpEpoch();
}

async function stopEntry(entry: Live, terminate: boolean) {
  if (entry.stopping) return;
  entry.stopping = true;
  await Promise.all(childrenOf(entry).map((child) => stopEntry(child, terminate)));
  await entry.session.stop(terminate && entry.request === 'launch').catch(() => {});
  finish(entry);
}

function rootOf(entry: Live): Live {
  let current = entry;
  while (current.session.parent) {
    const parent = live.get(current.session.parent.id);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** The session you're looking at (or the newest one), as a root. */
function focusedRoot(): Live | null {
  const focus = useDebug.getState().focus;
  const focused = focus ? live.get(focus.sessionId) : undefined;
  const any = focused ?? [...live.values()].at(-1);
  return any ? rootOf(any) : null;
}

/** Shift+F5. */
export async function stopDebugging() {
  const root = focusedRoot();
  if (root) await stopEntry(root, true);
}

export async function stopAllDebugging() {
  await Promise.all(
    [...live.values()].filter((e) => !e.session.parent).map((e) => stopEntry(e, true)),
  );
}

/** Ctrl+Shift+F5: stops and starts the session again (rebuilding a file first). */
export async function restartDebugging() {
  const root = focusedRoot();
  if (!root) return;
  const again = root.restart;
  await stopEntry(root, true);
  if (again) await again();
}

// ---- What you ask of it ----

/** The live session you're looking at, and its thread. */
function target(): { entry: Live; threadId: number | null } | null {
  const focus = useDebug.getState().focus;
  let entry = focus ? live.get(focus.sessionId) : undefined;
  if (!entry) {
    // Not paused yet: the newest session that runs the program itself.
    entry = [...live.values()].reverse().find((e) => !childrenOf(e).length);
  }
  if (!entry) return null;
  const info = sessionInfo(entry.session.id);
  const threadId =
    (focus?.sessionId === entry.session.id ? focus.threadId : null) ??
    info?.threads.find((t) => t.stopped)?.id ??
    info?.threads[0]?.id ??
    null;
  return { entry, threadId };
}

export type ThreadCommand = 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause';

const LABELS: Record<ThreadCommand, string> = {
  continue: 'Continue',
  next: 'Step over',
  stepIn: 'Step into',
  stepOut: 'Step out',
  pause: 'Pause',
};

/** F5 (continue), F10, F11, Shift+F11 and F6 (pause) on the thread you're looking at. */
export async function threadCommand(command: ThreadCommand) {
  const found = target();
  if (!found) return;
  const { entry } = found;
  let { threadId } = found;
  if (threadId === null) threadId = (await fetchThreads(entry))[0]?.id ?? null;
  if (threadId === null) return;
  // Steps and continue run every thread here (as the adapters do); the stop event comes back.
  if (command !== 'pause') resumeThreads(entry, null);
  try {
    await entry.session.request(command, { threadId });
  } catch (err) {
    notify('warning', `${LABELS[command]} didn't work.`, { detail: errorMessage(err) });
  }
}

export interface Scope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
}

const cache = new Map<string, Promise<unknown>>();
let cacheEpoch = -1;

/** Values stay the same until the program moves (the epoch changes). */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const { epoch } = useDebug.getState();
  if (epoch !== cacheEpoch) {
    cache.clear();
    cacheEpoch = epoch;
  }
  let value = cache.get(key) as Promise<T> | undefined;
  if (!value) {
    value = load();
    cache.set(key, value);
    value.catch(() => cache.delete(key));
  }
  return value;
}

export function scopesOf(sessionId: string, frameId: number): Promise<Scope[]> {
  const entry = live.get(sessionId);
  if (!entry) return Promise.resolve([]);
  return cached(`${sessionId}:scopes:${frameId}`, async () => {
    const body = await entry.session.request<{ scopes?: Scope[] }>('scopes', { frameId });
    return body.scopes ?? [];
  });
}

export function variablesOf(sessionId: string, reference: number): Promise<Variable[]> {
  const entry = live.get(sessionId);
  if (!entry || reference <= 0) return Promise.resolve([]);
  return cached(`${sessionId}:vars:${reference}`, async () => {
    const body = await entry.session.request<{ variables?: Variable[] }>('variables', {
      variablesReference: reference,
    });
    return (body.variables ?? []).map((v) => ({ ...v, value: String(v.value ?? '') }));
  });
}

export interface Evaluated {
  result: string;
  type?: string;
  variablesReference: number;
  sessionId: string;
}

/** Evaluates in the frame you're looking at. */
export async function evaluate(
  expression: string,
  context: 'watch' | 'repl' | 'hover',
): Promise<Evaluated> {
  const found = target();
  if (!found) throw new Error('No debug session is running.');
  const { entry } = found;
  const focus = useDebug.getState().focus;
  const frameId = focus?.sessionId === entry.session.id ? (focus.frameId ?? undefined) : undefined;
  const run = async () => {
    const body = await entry.session.request<{
      result?: string;
      type?: string;
      variablesReference?: number;
    }>('evaluate', { expression, context, frameId });
    return {
      result: String(body.result ?? ''),
      type: body.type,
      variablesReference: body.variablesReference ?? 0,
      sessionId: entry.session.id,
    };
  };
  // The console's evaluations can change things; watches and hovers are read again freely.
  return context === 'repl'
    ? run()
    : cached(`${entry.session.id}:eval:${context}:${frameId}:${expression}`, run);
}

/** Changes a variable's value (double-click in Variables). */
export async function setVariableValue(
  sessionId: string,
  parentReference: number,
  name: string,
  value: string,
) {
  const entry = live.get(sessionId);
  if (!entry) return;
  try {
    await entry.session.request('setVariable', {
      variablesReference: parentReference,
      name,
      value,
    });
  } catch (err) {
    notify('warning', `Couldn't set ${name}.`, { detail: errorMessage(err) });
  }
  // Other values may depend on it.
  bumpEpoch();
}

/** Runs what you typed in the Debug console. */
export async function evaluateInConsole(expression: string) {
  appendConsole({ kind: 'input', text: expression });
  try {
    const result = await evaluate(expression, 'repl');
    appendConsole({
      kind: 'result',
      text: result.result,
      variablesReference: result.variablesReference || undefined,
      sessionId: result.sessionId,
    });
  } catch (err) {
    appendConsole({ kind: 'error', text: errorMessage(err) });
  }
  bumpEpoch();
}

/** Completions for the Debug console, when the adapter offers them. */
export async function completionsFor(
  text: string,
  column: number,
): Promise<{ label: string; text?: string; start?: number; length?: number }[]> {
  const found = target();
  if (!found || found.entry.session.capabilities.supportsCompletionsRequest !== true) return [];
  const focus = useDebug.getState().focus;
  const body = await found.entry.session
    .request<{ targets?: { label: string; text?: string; start?: number; length?: number }[] }>(
      'completions',
      {
        text,
        column,
        frameId:
          focus?.sessionId === found.entry.session.id ? (focus.frameId ?? undefined) : undefined,
      },
    )
    .catch(() => ({ targets: [] }));
  return body.targets ?? [];
}

// ---- Commands ----

/** Debugs the active file without a launch.json ("Debug this file"). */
export async function debugActiveFile() {
  const { doc } = activeTab();
  if (!doc) {
    notify('info', 'Open a file, then debug it.');
    return;
  }
  await debugFile(doc);
}

async function debugFile(doc: TextDoc): Promise<boolean> {
  if ((!doc.path || doc.dirty) && !(await saveDocument(doc))) return false;
  const folder = debugFolder(doc.path);
  if (!folder || !(await ensureTrusted(folder))) return false;
  const config = await fileConfiguration(doc);
  if (typeof config === 'string') {
    if (config) {
      notify('warning', config, {
        actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
      });
    }
    return false;
  }
  return startDebugging(config, { restart: () => debugFile(doc), trusted: true, folder });
}

/** F5 when nothing runs: the configuration picked in Run and debug, or the active file. */
export async function startSelected() {
  const root = useWorkspace.getState().root;
  const selected = useDebug.getState().selectedConfig;
  if (root && selected !== ACTIVE_FILE) {
    const configs = await loadConfigurations(root);
    const found = configs.find((c) => c.config.name === selected) ?? configs[0];
    if (found) {
      await startDebugging(found.config);
      return;
    }
  }
  await debugActiveFile();
}

/** Context keys for keybindings, and breakpoint changes sent as they happen. */
export function installDebugger(): () => void {
  const sync = () => {
    const state = useDebug.getState();
    setContext('inDebugMode', state.sessions.length > 0);
    setContext('debugState', debugStateOf(state));
  };
  sync();
  const stops = [useDebug.subscribe(sync), watchBreakpoints()];
  return () => stops.forEach((stop) => stop());
}
