// One debug session: Lathe's side of the Debug Adapter Protocol over a connection Rust holds (an
// adapter's stdio, or TCP either way). Responses are matched on request_seq alone. Start-up
// follows the order every adapter here expects: initialize, launch (answered last), wait for
// `initialized`, send breakpoints, configurationDone. The adapter's own requests are answered
// too: runInTerminal runs the program in a Lathe terminal, and startDebugging (js-debug) opens a
// child session.

import { type LspEvent, backend, errorMessage } from '../lib/backend';

export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface SessionHandlers {
  event(session: DebugSession, event: string, body: Record<string, unknown>): void;
  /** The adapter wants the program run in a terminal. */
  runInTerminal(session: DebugSession, args: Record<string, unknown>): Promise<void>;
  /** js-debug starts a child session for the program itself. */
  startDebugging(session: DebugSession, args: Record<string, unknown>): Promise<void>;
  /** The connection ended: the adapter exited, the socket closed, or we stopped. */
  closed(session: DebugSession): void;
  log(session: DebugSession, line: string): void;
}

/** A connection Rust holds open, by id. */
export interface Connection {
  id: string;
  close(): void;
}

const TIMEOUT_MS = 30_000;
/** Launching can build or start a big program first. */
const LAUNCH_TIMEOUT_MS = 120_000;

/** A failed request: what the adapter said (`body.error.format` first; js-debug's message is
 * often just "undefined"). */
export class DapError extends Error {}

function failure(message: DapMessage): string {
  const error = message.body?.error as { format?: unknown } | undefined;
  if (typeof error?.format === 'string' && error.format) return error.format;
  if (message.message && message.message !== 'undefined') return message.message;
  return `${message.command || 'The request'} failed.`;
}

export class DebugSession {
  private seq = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (body: Record<string, unknown>) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private initializedWaiters: (() => void)[] = [];
  private initializedSeen = false;
  capabilities: Record<string, unknown> = {};
  connection: Connection | null = null;
  ended = false;

  constructor(
    readonly id: string,
    readonly name: string,
    /** The adapter's id, sent as `adapterID`. */
    readonly adapterId: string,
    readonly configuration: Record<string, unknown>,
    private readonly handlers: SessionHandlers,
    readonly parent: DebugSession | null = null,
  ) {}

  /** The connection's events (from the backend's channel). */
  readonly onEvent = (event: LspEvent) => {
    if (event.type === 'log') this.handlers.log(this, event.line);
    else if (event.type === 'exit') this.closed();
    else this.receive(event.data);
  };

  attach(connection: Connection) {
    this.connection = connection;
  }

  private closed() {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new DapError('The debug adapter closed the connection.'));
    }
    this.pending.clear();
    for (const resolve of this.initializedWaiters.splice(0)) resolve();
    this.handlers.closed(this);
  }

  private send(message: Omit<DapMessage, 'seq'>): number {
    if (!this.connection || this.ended) throw new DapError('The debug session has ended.');
    const seq = ++this.seq;
    void backend()
      .debug.send(this.connection.id, JSON.stringify({ seq, ...message }))
      .catch((err: unknown) =>
        this.handlers.log(this, `[lathe] couldn't send ${message.command}: ${errorMessage(err)}`),
      );
    return seq;
  }

  request<T = Record<string, unknown>>(command: string, args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let seq: number;
      try {
        seq = this.send({
          type: 'request',
          command,
          arguments: args as Record<string, unknown>,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new DapError(String(err)));
        return;
      }
      const wait = command === 'launch' || command === 'attach' ? LAUNCH_TIMEOUT_MS : TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapError(`The debug adapter didn't answer ${command}.`));
      }, wait);
      this.pending.set(seq, {
        resolve: resolve as (body: Record<string, unknown>) => void,
        reject,
        timer,
      });
    });
  }

  private respond(request: DapMessage, body?: Record<string, unknown>, error?: string) {
    try {
      this.send({
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: !error,
        message: error,
        body: error ? { error: { id: 1, format: error } } : (body ?? {}),
      });
    } catch {
      // The session ended meanwhile.
    }
  }

  private receive(data: string) {
    let message: DapMessage;
    try {
      message = JSON.parse(data) as DapMessage;
    } catch {
      this.handlers.log(this, `[lathe] not JSON: ${data.slice(0, 200)}`);
      return;
    }
    if (message.type === 'response') {
      const waiter = this.pending.get(message.request_seq ?? -1);
      if (!waiter) return;
      this.pending.delete(message.request_seq!);
      clearTimeout(waiter.timer);
      if (message.success) waiter.resolve(message.body ?? {});
      else waiter.reject(new DapError(failure(message)));
      return;
    }
    if (message.type === 'event') {
      const event = message.event ?? '';
      if (event === 'initialized') {
        // js-debug's child sessions send it twice.
        if (this.initializedSeen) return;
        this.initializedSeen = true;
        for (const resolve of this.initializedWaiters.splice(0)) resolve();
        return;
      }
      this.handlers.event(this, event, message.body ?? {});
      return;
    }
    if (message.type === 'request') void this.reverseRequest(message);
  }

  private async reverseRequest(request: DapMessage) {
    const args = request.arguments ?? {};
    try {
      if (request.command === 'runInTerminal') {
        await this.handlers.runInTerminal(this, args);
        this.respond(request, {});
      } else if (request.command === 'startDebugging') {
        // Answer first: the child connects on its own afterwards.
        this.respond(request, {});
        await this.handlers.startDebugging(this, args);
      } else {
        this.respond(request, undefined, `Lathe doesn't support "${request.command}".`);
      }
    } catch (err) {
      this.respond(request, undefined, errorMessage(err));
    }
  }

  private initialized(): Promise<void> {
    if (this.initializedSeen || this.ended) return Promise.resolve();
    return new Promise((resolve) => this.initializedWaiters.push(resolve));
  }

  /** Starts the session: initialize, then launch or attach, then `configure` (breakpoints). */
  async start(request: 'launch' | 'attach', configure: () => Promise<void>): Promise<void> {
    this.capabilities = await this.request('initialize', {
      clientID: 'lathe',
      clientName: 'Lathe',
      adapterID: this.adapterId,
      locale: navigator.language || 'en',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: true,
      supportsStartDebuggingRequest: true,
      supportsInvalidatedEvent: true,
      supportsProgressReporting: false,
      supportsMemoryReferences: false,
      supportsArgsCanBeInterpretedByShell: false,
    });
    // Not awaited yet: the adapters answer launch only after configurationDone.
    const launched = this.request(request, this.configuration);
    launched.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notReady = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DapError("The debug adapter didn't get ready.")),
        TIMEOUT_MS,
      );
    });
    try {
      // A launch that fails early rejects here; one that succeeds still waits for `initialized`.
      await Promise.race([this.initialized(), launched.then(() => this.initialized()), notReady]);
    } finally {
      clearTimeout(timer);
    }
    if (this.ended) throw new DapError('The debug adapter closed the connection.');
    await configure();
    if (this.capabilities.supportsConfigurationDoneRequest === true) {
      await this.request('configurationDone');
    }
    await launched;
  }

  /** Ends the session: disconnect (stopping the program if asked), then close the connection. */
  async stop(terminate: boolean) {
    if (!this.ended && this.connection) {
      await Promise.race([
        this.request('disconnect', { restart: false, terminateDebuggee: terminate }).catch(
          () => {},
        ),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    this.connection?.close();
    this.closed();
  }
}
