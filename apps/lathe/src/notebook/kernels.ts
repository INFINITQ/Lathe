// Jupyter kernels for notebooks and # %% cells: which ones are installed (Python environments
// with ipykernel, and kernelspecs in Jupyter's folders), running one, and routing what it sends
// back to the request that caused it. A request is done only once both its reply and iopub's
// `idle` have arrived; they come in either order.

import { create } from 'zustand';
import { type KernelEvent, type KernelSpecInfo, backend, errorMessage } from '../lib/backend';
import { newId } from '../lib/events';
import { basename, dirname, isUnder, join, pathKey } from '../lib/paths';
import { ask } from '../services/dialogs';
import { notify } from '../services/notifications';
import { showView } from '../workbench/layout';
import { quickPick } from '../workbench/quickinput/store';
import { runInTerminal, terminalExited } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';

export interface KernelChoice {
  /** "python:<path>" or "spec:<name>". */
  id: string;
  label: string;
  description: string;
  language: string;
  argv: string[];
  env: [string, string][];
  interruptMode: string;
  /** The kernelspec name a notebook records (metadata.kernelspec.name). */
  specName: string;
}

interface Interpreter {
  path: string;
  version: string;
  prefix: string;
  hasKernel: boolean;
}

async function exists(path: string): Promise<boolean> {
  return !!(await backend()
    .fs.stat(path)
    .catch(() => null));
}

const PROBE =
  'import sys, importlib.util as u; print(sys.executable); print(sys.prefix); ' +
  "print(sys.version.split()[0]); print(u.find_spec('ipykernel') is not None)";

async function probe(python: string): Promise<Interpreter | null> {
  const result = await backend()
    .toolchains.capture({
      program: python,
      args: ['-I', '-c', PROBE],
      cwd: backend().boot().dataDir || 'C:\\',
      env: [],
      timeoutMs: 20_000,
    })
    .catch(() => null);
  if (!result || result.code !== 0) return null;
  const [path, prefix, version, has] = result.output.trim().split(/\r?\n/).slice(-4);
  if (!path || !prefix || !version) return null;
  return {
    path: path.trim(),
    prefix: prefix.trim(),
    version: version.trim(),
    hasKernel: has?.trim() === 'True',
  };
}

let found: Promise<{ choices: KernelChoice[]; without: Interpreter[] }> | null = null;

/** Forgets what was found (after an install). */
export function rescanKernels() {
  found = null;
}

/** The kernels you can pick, and the Pythons that would be kernels with ipykernel installed. */
export function findKernels(): Promise<{ choices: KernelChoice[]; without: Interpreter[] }> {
  found ??= scan().catch((err: unknown) => {
    found = null;
    throw err;
  });
  return found;
}

async function scan(): Promise<{ choices: KernelChoice[]; without: Interpreter[] }> {
  const root = useWorkspace.getState().root;
  const candidates: string[] = [];
  for (const dir of root ? ['.venv', 'venv', 'env'] : []) {
    const python = join(root!, dir, 'Scripts', 'python.exe');
    if (await exists(python)) candidates.push(python);
  }
  for (const name of ['python', 'py']) {
    const python = await backend()
      .toolchains.which(name)
      .catch(() => null);
    if (python) {
      candidates.push(python);
      break;
    }
  }
  const interpreters: Interpreter[] = [];
  for (const candidate of candidates) {
    const info = await probe(candidate);
    if (info && !interpreters.some((i) => pathKey(i.path) === pathKey(info.path))) {
      interpreters.push(info);
    }
  }
  const specs = await backend()
    .kernels.specs(interpreters.map((i) => i.prefix))
    .catch((): KernelSpecInfo[] => []);
  const choices: KernelChoice[] = [];
  for (const python of interpreters.filter((i) => i.hasKernel)) {
    const env =
      root && isUnder(python.path, root) ? ` (${basename(dirname(dirname(python.path)))})` : '';
    choices.push({
      id: `python:${python.path}`,
      label: `Python ${python.version}${env}`,
      description: python.path,
      language: 'python',
      argv: [python.path, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
      env: [],
      interruptMode: 'signal',
      specName: 'python3',
    });
  }
  for (const spec of specs) {
    // A bare "python" belongs to the environment the spec came with, never to PATH.
    const owner = interpreters.find((i) => isUnder(spec.dir, i.prefix));
    const bare = /^python(3)?(\.exe)?$/i.test(spec.argv[0] ?? '');
    if (bare && spec.name === 'python3' && (owner || interpreters.length)) continue;
    const argv = [...spec.argv];
    if (bare) {
      const python = owner ?? interpreters[0];
      if (!python) continue;
      argv[0] = python.path;
    }
    choices.push({
      id: `spec:${spec.name}`,
      label: spec.displayName,
      description: spec.dir,
      language: spec.language,
      argv,
      env: Object.entries(spec.env),
      interruptMode: spec.interruptMode,
      specName: spec.name,
    });
  }
  return { choices, without: interpreters.filter((i) => !i.hasKernel) };
}

/** Installs ipykernel into a Python (after asking), in a terminal you can watch. */
export async function installIpykernel(python: Interpreter): Promise<boolean> {
  const answer = await ask({
    title: `Install ipykernel into Python ${python.version}?`,
    message: `Notebooks run code through a Jupyter kernel. Lathe will run this in a terminal:\n"${python.path}" -m pip install ipykernel`,
    buttons: [
      { id: 'install', label: 'Install', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'install') return false;
  const info = await runInTerminal({
    title: 'Install ipykernel',
    program: python.path,
    args: ['-m', 'pip', 'install', 'ipykernel'],
    cwd: dirname(python.path),
    env: [],
    tag: 'install:ipykernel',
  });
  if (!info || (await terminalExited(info.id)).code !== 0) {
    notify('error', "Installing ipykernel didn't finish.", { detail: 'The terminal shows why.' });
    return false;
  }
  rescanKernels();
  notify('info', 'ipykernel is installed.');
  return true;
}

/**
 * Which kernel to run with: the one a notebook names (`wanted`, its kernelspec name), or the only
 * one there is; otherwise (or `always`) a choice, which can also install ipykernel.
 */
export async function pickKernel(options: {
  wanted?: unknown;
  always: boolean;
  placeholder: string;
}): Promise<KernelChoice | null> {
  let scanned;
  try {
    scanned = await findKernels();
  } catch (err) {
    notify('error', "Couldn't look for Jupyter kernels.", { detail: errorMessage(err) });
    return null;
  }
  const { choices, without } = scanned;
  const again = () => pickKernel({ ...options, always: false });
  if (!options.always) {
    const match =
      choices.find((c) => c.specName === options.wanted && c.id.startsWith('spec:')) ??
      choices.find((c) => c.specName === options.wanted);
    if (match) return match;
    if (choices.length === 1) return choices[0]!;
  }
  if (!choices.length && !without.length) {
    notify('warning', 'No Jupyter kernel is installed.', {
      detail: 'Install Python from Run and debug → Toolchains, then ipykernel.',
      actions: [{ label: 'Show toolchains', run: () => showView('debug') }],
    });
    return null;
  }
  if (!choices.length && !options.always) {
    return (await installIpykernel(without[0]!)) ? again() : null;
  }
  const picked = await quickPick(
    [
      ...choices.map((c) => ({ id: c.id, label: c.label, description: c.description })),
      ...without.map((p) => ({
        id: `install:${p.path}`,
        label: `Install ipykernel into Python ${p.version}…`,
        description: p.path,
      })),
    ],
    { placeholder: options.placeholder },
  );
  if (!picked) return null;
  if (picked.id.startsWith('install:')) {
    const python = without.find((p) => `install:${p.path}` === picked.id);
    return python && (await installIpykernel(python)) ? again() : null;
  }
  return choices.find((c) => c.id === picked.id) ?? null;
}

export type KernelStatus = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead';

/** What a running request reports, as it happens. */
export interface RequestHandlers {
  /** stream, display_data, execute_result, error, clear_output, update_display_data. */
  output(type: string, content: Record<string, unknown>): void;
  /** execute_input: the execution count. */
  count?(count: number): void;
  /** input(): the program asks for a line. */
  input?(prompt: string, password: boolean): void;
}

export interface Finished {
  /** "ok", "error", "aborted", or "dead" if the kernel stopped. */
  status: string;
  count: number | null;
}

interface Route {
  handlers: RequestHandlers;
  replied: boolean;
  idle: boolean;
  count: number | null;
  status: string;
  done: (result: Finished) => void;
}

interface KernelState {
  /** By owner (a notebook's document id, or a file path for # %% cells). */
  status: Record<string, KernelStatus>;
  label: Record<string, string>;
}

export const useKernels = create<KernelState>(() => ({ status: {}, label: {} }));

/** A running kernel, owned by a notebook (or a .py file's # %% cells). */
export class KernelSession {
  id: string | null = null;
  info: Record<string, unknown> = {};
  private readonly routes = new Map<string, Route>();
  /** The request running now, which gets the kernel's own printing. */
  private current: string | null = null;

  constructor(
    readonly owner: string,
    readonly choice: KernelChoice,
    readonly cwd: string,
  ) {}

  get status(): KernelStatus {
    return useKernels.getState().status[this.owner] ?? 'dead';
  }

  private setStatus(status: KernelStatus) {
    useKernels.setState((s) => ({
      status: { ...s.status, [this.owner]: status },
      label: { ...s.label, [this.owner]: this.choice.label },
    }));
  }

  async start() {
    this.setStatus('starting');
    try {
      const started = await backend().kernels.start(
        {
          argv: this.choice.argv,
          env: this.choice.env,
          cwd: this.cwd,
          interruptMode: this.choice.interruptMode,
        },
        (event) => this.onEvent(event),
      );
      this.id = started.id;
      this.info = started.info;
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('dead');
      throw err;
    }
  }

  /** The language the kernel speaks ("python"), from kernel_info. */
  get language(): string {
    const info = this.info.language_info as { name?: string } | undefined;
    return info?.name ?? this.choice.language;
  }

  private onEvent(event: KernelEvent) {
    if (event.type === 'exit') {
      this.id = null;
      this.setStatus('dead');
      this.finishAll('dead');
      notify('error', `The kernel ${this.choice.label} stopped.`, {
        detail: event.code === null ? undefined : `Exit code ${event.code}.`,
      });
      return;
    }
    if (event.type === 'log') {
      // The kernel's own printing (os.system, C code): it belongs to what's running.
      const route = this.current ? this.routes.get(this.current) : undefined;
      route?.handlers.output('stream', { name: 'stdout', text: `${event.line}\n` });
      return;
    }
    const route = event.parentId ? this.routes.get(event.parentId) : undefined;
    if (!route) return;
    const content = event.content;
    switch (event.msgType) {
      case 'status':
        if (content.execution_state === 'busy') this.current = event.parentId;
        if (content.execution_state === 'idle') {
          route.idle = true;
          this.settle(event.parentId!, route);
        }
        break;
      case 'execute_input':
        if (typeof content.execution_count === 'number') {
          route.count = content.execution_count;
          route.handlers.count?.(content.execution_count);
        }
        break;
      case 'execute_reply':
        route.replied = true;
        route.status = String(content.status ?? 'ok');
        if (typeof content.execution_count === 'number') route.count = content.execution_count;
        this.settle(event.parentId!, route);
        break;
      case 'input_request':
        route.handlers.input?.(String(content.prompt ?? ''), content.password === true);
        break;
      case 'stream':
      case 'display_data':
      case 'execute_result':
      case 'error':
      case 'clear_output':
      case 'update_display_data':
        route.handlers.output(event.msgType, content);
        break;
      default:
        break;
    }
  }

  private settle(id: string, route: Route) {
    if (!route.replied || !route.idle) return;
    this.routes.delete(id);
    if (this.current === id) this.current = null;
    route.done({ status: route.status, count: route.count });
    if (!this.routes.size && this.status === 'busy') this.setStatus('idle');
  }

  private finishAll(status: string) {
    for (const [id, route] of this.routes) {
      this.routes.delete(id);
      route.done({ status, count: route.count });
    }
    this.current = null;
  }

  /** Runs code; resolves when the kernel is done with it. */
  execute(code: string, handlers: RequestHandlers): Promise<Finished> {
    const id = this.id;
    if (!id) return Promise.resolve({ status: 'dead', count: null });
    const msgId = newId();
    const finished = new Promise<Finished>((done) => {
      this.routes.set(msgId, {
        handlers,
        replied: false,
        idle: false,
        count: null,
        status: 'ok',
        done,
      });
    });
    this.setStatus('busy');
    backend()
      .kernels.execute(id, msgId, code, { allowStdin: !!handlers.input })
      .catch((err: unknown) => {
        const route = this.routes.get(msgId);
        if (!route) return;
        this.routes.delete(msgId);
        route.handlers.output('error', {
          ename: 'Error',
          evalue: errorMessage(err),
          traceback: [errorMessage(err)],
        });
        route.done({ status: 'error', count: null });
      });
    return finished;
  }

  async complete(
    code: string,
    cursor: number,
  ): Promise<{ matches: string[]; start: number; end: number } | null> {
    if (!this.id || this.status === 'busy') return null;
    const reply = await backend()
      .kernels.complete(this.id, code, cursor)
      .catch(() => null);
    if (!reply || reply.status !== 'ok') return null;
    return {
      matches: Array.isArray(reply.matches) ? reply.matches.map(String) : [],
      start: Number(reply.cursor_start ?? cursor),
      end: Number(reply.cursor_end ?? cursor),
    };
  }

  async inspect(code: string, cursor: number): Promise<string | null> {
    if (!this.id || this.status === 'busy') return null;
    const reply = await backend()
      .kernels.inspect(this.id, code, cursor)
      .catch(() => null);
    if (!reply || reply.status !== 'ok' || !reply.found) return null;
    const data = reply.data as Record<string, unknown> | undefined;
    return typeof data?.['text/plain'] === 'string' ? data['text/plain'] : null;
  }

  async input(value: string) {
    if (this.id) await backend().kernels.input(this.id, value);
  }

  async interrupt() {
    if (this.id) await backend().kernels.interrupt(this.id);
  }

  async restart() {
    if (!this.id) {
      await this.start();
      return;
    }
    this.setStatus('restarting');
    this.finishAll('aborted');
    try {
      this.info = await backend().kernels.restart(this.id);
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('dead');
      throw err;
    }
  }

  async shutdown() {
    const id = this.id;
    this.id = null;
    this.finishAll('aborted');
    useKernels.setState((s) => {
      const status = { ...s.status };
      delete status[this.owner];
      return { status };
    });
    if (id) await backend().kernels.shutdown(id);
  }
}

/** UTF-16 offset → code points (what kernels count). */
export function toCodePoints(text: string, offset: number): number {
  return [...text.slice(0, offset)].length;
}

/** Code points → a UTF-16 offset. */
export function fromCodePoints(text: string, points: number): number {
  let offset = 0;
  let count = 0;
  for (const char of text) {
    if (count === points) break;
    offset += char.length;
    count++;
  }
  return offset;
}
