// A running plugin: a hidden frame on the lathe-plugin origin whose Worker runs the plugin's code.
// What it asks of Lathe arrives here as messages and goes through api.ts, which checks its
// permissions. What Lathe asks of it (run a command, complete a word) goes back the same way
// with a time limit, so a plugin that hangs or crashes never takes the editor with it.

import { type InstalledPlugin, errorMessage } from '../lib/backend';
import { notify } from '../services/notifications';
import { appendOutput, useOutput } from '../services/output';
import { showPanel } from '../workbench/layout';
import { callApi, forgetPlugin } from './api';
import { removeStatusItems, setPluginStatus } from './store';

export const PLUGIN_ORIGIN = 'http://lathe-plugin.localhost';

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const hosts = new Map<string, PluginHost>();

export function hostOf(id: string): PluginHost | undefined {
  return hosts.get(id);
}

export function allHosts(): PluginHost[] {
  return [...hosts.values()];
}

/** Restarts after a crash, but not more than this often. */
const CRASHES_ALLOWED = 3;
const CRASH_WINDOW_MS = 5 * 60_000;

export class PluginHost {
  frame: HTMLIFrameElement | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, Waiting>();
  private ready: Promise<void> = Promise.resolve();
  private settle: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private crashes: number[] = [];

  constructor(readonly plugin: InstalledPlugin) {}

  get id(): string {
    return this.plugin.manifest.id;
  }

  get name(): string {
    return this.plugin.manifest.name;
  }

  private channel(): string {
    return `Plugin: ${this.name}`;
  }

  log(text: string) {
    appendOutput(this.channel(), text.endsWith('\n') ? text : `${text}\n`);
  }

  showLog() {
    useOutput.setState({ active: this.channel() });
    showPanel('output');
  }

  /** Starts the plugin; resolves once its activate() returned. */
  start(): Promise<void> {
    if (this.frame) return this.ready;
    hosts.set(this.id, this);
    setPluginStatus(this.id, 'starting');
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready.catch(() => {});
    const frame = document.createElement('iframe');
    frame.src = `${PLUGIN_ORIGIN}/__host/${encodeURIComponent(this.id)}/`;
    // Its own origin, so it can start its Worker; never Lathe's, so it can't reach Lathe.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.title = `Plugin ${this.name}`;
    frame.dataset.plugin = this.id;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    document.body.append(frame);
    this.frame = frame;
    const timer = setTimeout(() => this.fail("It didn't start within 20 seconds."), 20_000);
    this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
    return this.ready;
  }

  private fail(message: string) {
    setPluginStatus(this.id, 'failed', message);
    this.settle?.reject(new Error(message));
    this.settle = null;
  }

  /** A message from the plugin's frame. */
  handle(message: Record<string, unknown>) {
    switch (message.type) {
      case 'activated':
        setPluginStatus(this.id, 'running');
        this.settle?.resolve();
        this.settle = null;
        break;
      case 'activationFailed': {
        const text = String(message.message ?? 'It failed to start.');
        this.log(`activate() failed: ${text}`);
        this.fail(text);
        notify('error', `${this.name} didn't start.`, {
          detail: text,
          actions: [{ label: 'Show log', run: () => this.showLog() }],
        });
        break;
      }
      case 'crashed':
        this.crashed(String(message.message ?? 'It stopped.'));
        break;
      case 'log':
        this.log(`[${String(message.level ?? 'log')}] ${String(message.message ?? '')}`);
        break;
      case 'call':
        void this.answer(Number(message.id), String(message.method), message.params);
        break;
      case 'reply': {
        const waiting = this.waiting.get(Number(message.id));
        if (!waiting) return;
        this.waiting.delete(Number(message.id));
        clearTimeout(waiting.timer);
        if (typeof message.error === 'string') waiting.reject(new Error(message.error));
        else waiting.resolve(message.result);
        break;
      }
      default:
        break;
    }
  }

  private async answer(id: number, method: string, params: unknown) {
    try {
      const result = await callApi(this, method, (params ?? {}) as Record<string, unknown>);
      this.post({ type: 'result', id, result: result ?? null });
    } catch (err) {
      this.post({ type: 'result', id, error: errorMessage(err) });
    }
  }

  post(message: Record<string, unknown>) {
    this.frame?.contentWindow?.postMessage(message, PLUGIN_ORIGIN);
  }

  /** Tells the plugin something happened (the active editor changed…). */
  event(name: string, data: unknown) {
    this.post({ type: 'event', event: name, data });
  }

  /** Calls one of the plugin's handlers ("command:<id>", "provider:<id>"). */
  async invoke(handler: string, args: unknown[], timeoutMs = 10_000): Promise<unknown> {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name} didn't answer in time.`));
        if (handler.startsWith('command:')) this.unresponsive();
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.post({ type: 'invoke', id, handler, args });
    });
  }

  private unresponsive() {
    this.log('A command took too long; the plugin may be stuck.');
    notify('warning', `${this.name} isn't responding.`, {
      detail: 'Its code runs apart from the editor, so Lathe carries on. Restart it to stop it.',
      actions: [
        { label: 'Restart it', run: () => this.restart() },
        { label: 'Show log', run: () => this.showLog() },
      ],
    });
  }

  private crashed(message: string) {
    this.log(`It stopped: ${message}`);
    this.rejectWaiting(`${this.name} stopped.`);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    if (this.crashes.length <= CRASHES_ALLOWED) {
      notify('warning', `${this.name} stopped, and Lathe restarted it.`, {
        detail: message,
        actions: [{ label: 'Show log', run: () => this.showLog() }],
      });
      this.restart();
    } else {
      setPluginStatus(this.id, 'crashed', message);
      notify('error', `${this.name} keeps stopping, so Lathe left it off.`, {
        detail: message,
        actions: [{ label: 'Show log', run: () => this.showLog() }],
      });
    }
  }

  private rejectWaiting(reason: string) {
    for (const [id, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      this.waiting.delete(id);
    }
  }

  /** Starts the plugin's Worker again (its registrations come back with its activate()). */
  restart() {
    this.rejectWaiting(`${this.name} restarted.`);
    forgetPlugin(this, { keepCommands: true });
    removeStatusItems(this.id);
    setPluginStatus(this.id, 'starting');
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready.catch(() => {});
    this.post({ type: 'restart' });
  }

  stop() {
    this.post({ type: 'stop' });
    this.rejectWaiting(`${this.name} was turned off.`);
    forgetPlugin(this, { keepCommands: false });
    removeStatusItems(this.id);
    this.frame?.remove();
    this.frame = null;
    this.settle = null;
    hosts.delete(this.id);
    setPluginStatus(this.id, 'idle');
  }
}

let listening = false;

/** Messages from plugin frames go to their host (installed once). */
export function listenToPlugins() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    if (event.origin !== PLUGIN_ORIGIN) return;
    const data = event.data as Record<string, unknown> | null;
    const host = typeof data?.plugin === 'string' ? hosts.get(data.plugin) : undefined;
    if (!host || event.source !== host.frame?.contentWindow) return;
    host.handle(data!);
  });
}
