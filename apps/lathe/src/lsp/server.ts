// One language server for one folder: its process (run by Rust), its LSP client, and Lathe's
// session layer between them. The layer answers the server's own requests (the client library
// would refuse them), sends diagnostics to Problems and logs to Output, tracks progress, tells
// the server about saves and file changes, and restarts it if it crashes.

import {
  LSPClient,
  type LSPClientExtension,
  type Transport,
  hoverTooltips,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
} from '@codemirror/lsp-client';
import type * as lsp from 'vscode-languageserver-protocol';
import { create } from 'zustand';
import { type FsChange, backend, errorMessage } from '../lib/backend';
import { basename, isUnder, pathKey } from '../lib/paths';
import { notify } from '../services/notifications';
import { getSetting } from '../services/settings';
import { appendOutput } from '../services/output';
import { type Problem, setProblems } from '../services/problems';
import { openPath } from '../workbench/editors/store';
import { showPanel } from '../workbench/layout';
import { quickPick } from '../workbench/quickinput/store';
import { applyWorkspaceEdit } from './edits';
import { sanitizeHTML } from './sanitize';
import type { ServerDef, ServerLaunch } from './servers';
import { pathToUri, uriToPath } from './uri';
import { LatheWorkspace } from './workspace';

export type ServerState = 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';

export interface ServerInfo {
  key: string;
  id: string;
  name: string;
  root: string;
  state: ServerState;
  /** "Indexing 40%", while the server reports work in progress. */
  progress: string | null;
  error: string | null;
}

export const useLanguageServers = create<{ servers: Record<string, ServerInfo> }>(() => ({
  servers: {},
}));

/** What Lathe supports beyond the client library's own capabilities. */
const CAPABILITIES: LSPClientExtension = {
  clientCapabilities: {
    general: { positionEncodings: ['utf-16'] },
    workspace: {
      configuration: true,
      workspaceFolders: true,
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ['create', 'rename', 'delete'],
        failureHandling: 'abort',
      },
      didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
      symbol: { dynamicRegistration: false },
      executeCommand: { dynamicRegistration: false },
      inlayHint: { refreshSupport: true },
    },
    textDocument: {
      synchronization: { didSave: true },
      codeAction: {
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              '',
              'quickfix',
              'refactor',
              'refactor.extract',
              'refactor.inline',
              'refactor.rewrite',
              'source',
              'source.organizeImports',
              'source.fixAll',
            ],
          },
        },
        isPreferredSupport: true,
        disabledSupport: true,
        dataSupport: true,
        resolveSupport: { properties: ['edit'] },
      },
      rename: { prepareSupport: true },
      documentHighlight: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      inlayHint: {},
      publishDiagnostics: { relatedInformation: true },
    },
    window: { workDoneProgress: true, showDocument: { support: true } },
  },
};

/** $/progress, for work-done progress. */
interface Progress {
  token: string | number;
  value: lsp.WorkDoneProgressBegin | lsp.WorkDoneProgressReport | lsp.WorkDoneProgressEnd;
}

const MAX_RESTARTS = 4;
const RESTART_WINDOW_MS = 3 * 60_000;

/** Settings as a tree, from dotted sections: {"python.analysis": {...}} → {python: {analysis}}. */
export function configurationFor(
  settings: Record<string, unknown> | undefined,
  section: string | undefined,
): unknown {
  const tree: Record<string, unknown> = {};
  for (const [dotted, value] of Object.entries(settings ?? {})) {
    const parts = dotted.split('.');
    let node = tree;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        const existing = node[part];
        node[part] =
          existing && typeof existing === 'object' && value && typeof value === 'object'
            ? { ...(existing as object), ...(value as object) }
            : value;
      } else {
        node[part] = (node[part] as Record<string, unknown> | undefined) ?? {};
        node = node[part] as Record<string, unknown>;
      }
    });
  }
  if (!section) return tree;
  let value: unknown = tree;
  for (const part of section.split('.')) {
    if (!value || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[part];
  }
  return value ?? null;
}

/**
 * The client library chains notifications and some requests on its 'initializing' promise with
 * no error handler, so a server that dies before answering 'initialize' turns every queued
 * notification into an uncaught error. This sends notifications itself, and lets signature
 * help (whose typed triggers aren't caught either) quietly come back empty.
 */
class LatheClient extends LSPClient {
  constructor(
    private readonly send: (message: string) => void,
    config: ConstructorParameters<typeof LSPClient>[0],
  ) {
    super(config);
  }

  override notification<Params>(method: string, params: Params): void {
    if (!this.connected) return;
    this.initializing.then(
      () => {
        if (this.connected) this.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
      },
      () => {},
    );
  }

  override request<Params, Result>(method: string, params: Params): Promise<Result> {
    const pending = super.request<Params, Result>(method, params);
    if (method === 'textDocument/signatureHelp') return pending.catch(() => null as Result);
    return pending;
  }
}

/** The server behind each client (quick fixes need its diagnostics). */
export const serverOfClient = new WeakMap<LSPClient, LanguageServer>();

export class LanguageServer {
  readonly client: LSPClient;
  /** The server's latest diagnostics, by file URI (quick fixes send them back). */
  readonly diagnostics = new Map<string, lsp.Diagnostic[]>();
  private session: string | null = null;
  /** The transport's send, for the client's own notifications. */
  private transportSend: ((message: string) => void) | null = null;
  private readonly handlers = new Set<(message: string) => void>();
  private stopping = false;
  private crashes: number[] = [];
  private readonly progress = new Map<string | number, { title: string; detail: string }>();
  private readonly problems = new Map<string, Problem[]>();
  private recentLog: string[] = [];
  /** Called each time the server is (again) ready. */
  onReady: () => void = () => {};
  /** Rejects when the server exits before it's ready (set on each start). */
  private exitedEarly: ((code: number | null) => void) | null = null;

  constructor(
    readonly def: ServerDef,
    readonly root: string,
    readonly key: string,
    private readonly launch: ServerLaunch,
  ) {
    this.client = new LatheClient((message) => this.transportSend?.(message), {
      rootUri: pathToUri(root),
      workspace: (client) => new LatheWorkspace(client),
      timeout: 15_000,
      sanitizeHTML,
      initializationOptions: def.initializationOptions,
      extensions: [
        CAPABILITIES,
        serverCompletion(),
        hoverTooltips(),
        signatureHelp(),
        serverDiagnostics(),
      ],
      unhandledNotification: () => {},
    });
    serverOfClient.set(this.client, this);
    this.update({ state: 'starting', progress: null, error: null });
  }

  get state(): ServerState {
    return useLanguageServers.getState().servers[this.key]?.state ?? 'stopped';
  }

  get outputChannel(): string {
    return this.def.name;
  }

  private update(patch: Partial<ServerInfo>) {
    useLanguageServers.setState((s) => ({
      servers: {
        ...s.servers,
        [this.key]: {
          key: this.key,
          id: this.def.id,
          name: this.def.name,
          root: this.root,
          state: 'starting',
          progress: null,
          error: null,
          ...s.servers[this.key],
          ...patch,
        },
      },
    }));
  }

  private log(line: string) {
    appendOutput(this.outputChannel, `${line}\n`);
    this.recentLog = [...this.recentLog, line].slice(-12);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.update({ state: this.crashes.length ? 'restarting' : 'starting', error: null });
    const started = await backend().lsp.start(
      {
        program: this.launch.program,
        args: this.launch.args,
        cwd: this.root,
        env: this.launch.env ?? [],
      },
      (event) => {
        if (event.type === 'message') this.receive(event.data);
        else if (event.type === 'log') this.log(event.line);
        else this.exited(event.code);
      },
    );
    this.session = started.id;
    this.log(
      `[lathe] ${started.program} ${this.launch.args.join(' ')} (pid ${started.pid}) in ${this.root}`,
    );
    this.client.connect(this.transport());
    await Promise.race([
      this.client.initializing,
      new Promise<never>((_, reject) => {
        this.exitedEarly = (code) =>
          reject(
            new Error(
              `It stopped (exit code ${code ?? 'unknown'}) before it was ready. ${this.recentLog.slice(-3).join(' ')}`,
            ),
          );
      }),
    ]);
    this.exitedEarly = null;
    this.update({ state: 'running' });
    this.onReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const session = this.session;
    if (session && this.client.connected) {
      try {
        await Promise.race([
          this.client.request('shutdown', null).catch(() => null),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        this.client.notification('exit', null);
      } catch {
        // It's being killed anyway.
      }
    }
    this.client.disconnect();
    this.clearProblems();
    if (session) setTimeout(() => void backend().lsp.stop(session), 1000);
    this.session = null;
    this.update({ state: 'stopped', progress: null });
  }

  /** Restarts the server (a fresh process, the same client and editors). */
  async restart(): Promise<void> {
    await this.stop();
    this.crashes = [];
    await this.start();
  }

  private transport(): Transport {
    const transport: Transport = {
      send: (message) => {
        const session = this.session;
        if (!session) throw new Error(`${this.def.name} isn't running.`);
        if (getSetting('lsp.trace') === 'messages') this.log(`→ ${message.slice(0, 4000)}`);
        this.watchOutgoing(message);
        void backend()
          .lsp.send(session, this.prepare(message))
          .catch((err: unknown) =>
            this.log(`[lathe] couldn't send a message: ${errorMessage(err)}`),
          );
      },
      subscribe: (handler) => this.handlers.add(handler),
      unsubscribe: (handler) => this.handlers.delete(handler),
    };
    this.transportSend = (message) => {
      try {
        transport.send(message);
      } catch {
        // Not running: dropped, as the library does.
      }
    };
    return transport;
  }

  /** Fills in what the client library leaves out of `initialize`. */
  private prepare(message: string): string {
    if (!message.includes('"initialize"')) return message;
    const parsed = JSON.parse(message) as { method?: string; params?: Record<string, unknown> };
    if (parsed.method !== 'initialize' || !parsed.params) return message;
    parsed.params.clientInfo = { name: 'Lathe', version: '0.1.0' };
    parsed.params.rootPath = this.root;
    parsed.params.workspaceFolders = [{ uri: pathToUri(this.root), name: basename(this.root) }];
    parsed.params.locale = navigator.language;
    return JSON.stringify(parsed);
  }

  private sendRaw(value: unknown) {
    if (this.session)
      void backend()
        .lsp.send(this.session, JSON.stringify(value))
        .catch(() => {});
  }

  private receive(data: string) {
    if (getSetting('lsp.trace') === 'messages') this.log(`← ${data.slice(0, 4000)}`);
    let message: { id?: number | string; method?: string; params?: unknown };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      this.log(`[lathe] the server sent something that isn't JSON: ${data.slice(0, 200)}`);
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message as { id: number | string; method: string; params: unknown });
      return;
    }
    switch (message.method) {
      case 'textDocument/publishDiagnostics':
        this.diagnose(message.params as lsp.PublishDiagnosticsParams);
        break;
      case '$/progress':
        this.onProgress(message.params as Progress);
        return;
      case 'window/logMessage':
        this.log((message.params as lsp.LogMessageParams).message);
        return;
      case 'window/showMessage': {
        const params = message.params as lsp.ShowMessageParams;
        notify(
          params.type === 1 ? 'error' : params.type === 2 ? 'warning' : 'info',
          `${this.def.name}: ${params.message}`,
        );
        return;
      }
    }
    for (const handler of this.handlers) handler(data);
  }

  /** Requests from the server to the editor. */
  private async answer(request: { id: number | string; method: string; params: unknown }) {
    let result: unknown = null;
    let error: { code: number; message: string } | undefined;
    try {
      switch (request.method) {
        case 'workspace/configuration': {
          const items = (request.params as lsp.ConfigurationParams).items ?? [];
          result = items.map((item) => configurationFor(this.def.settings, item.section));
          break;
        }
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
        case 'workspace/semanticTokens/refresh':
        case 'workspace/codeLens/refresh':
        case 'workspace/foldingRange/refresh':
          break;
        case 'workspace/diagnostic/refresh':
          for (const file of this.client.workspace.files) this.schedulePull(file.uri, 100);
          break;
        case 'workspace/inlayHint/refresh':
          window.dispatchEvent(new CustomEvent('lathe:inlay-refresh'));
          break;
        case 'workspace/workspaceFolders':
          result = [{ uri: pathToUri(this.root), name: basename(this.root) }];
          break;
        case 'workspace/applyEdit': {
          const params = request.params as lsp.ApplyWorkspaceEditParams;
          const outcome = await applyWorkspaceEdit(params.edit);
          result = { applied: outcome.applied, failureReason: outcome.failure };
          break;
        }
        case 'window/showMessageRequest': {
          const params = request.params as lsp.ShowMessageRequestParams;
          const actions = params.actions ?? [];
          if (!actions.length) {
            notify('info', `${this.def.name}: ${params.message}`);
            break;
          }
          const picked = await quickPick(
            actions.map((a, i) => ({ id: String(i), label: a.title })),
            { placeholder: `${this.def.name}: ${params.message}` },
          );
          result = picked ? actions[Number(picked.id)] : null;
          break;
        }
        case 'window/showDocument': {
          const params = request.params as lsp.ShowDocumentParams;
          const path = uriToPath(params.uri);
          if (params.external || !path) await backend().openLink(params.uri);
          else
            await openPath(path, {
              selection: params.selection
                ? {
                    line: params.selection.start.line + 1,
                    column: params.selection.start.character + 1,
                  }
                : undefined,
            });
          result = { success: true };
          break;
        }
        default:
          error = { code: -32601, message: `Lathe doesn't support ${request.method}.` };
      }
    } catch (err) {
      error = { code: -32603, message: errorMessage(err) };
    }
    this.sendRaw({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) });
  }

  // Pull diagnostics (LSP 3.17): servers like TypeScript 7 wait to be asked instead of
  // publishing. Lathe asks after a file opens, changes or is saved, and hands the answer to
  // the same path as published diagnostics.

  private readonly pulls = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly resultIds = new Map<string, string>();

  private watchOutgoing(message: string) {
    if (
      !message.includes('"textDocument/did') ||
      !this.client.serverCapabilities?.diagnosticProvider
    )
      return;
    const parsed = JSON.parse(message) as {
      method?: string;
      params?: { textDocument?: { uri?: string } };
    };
    const uri = parsed.params?.textDocument?.uri;
    if (!uri) return;
    if (parsed.method === 'textDocument/didClose') {
      clearTimeout(this.pulls.get(uri));
      this.pulls.delete(uri);
      this.resultIds.delete(uri);
    } else if (parsed.method === 'textDocument/didOpen') {
      this.schedulePull(uri, 30);
    } else if (
      parsed.method === 'textDocument/didChange' ||
      parsed.method === 'textDocument/didSave'
    ) {
      this.schedulePull(uri, 350);
    }
  }

  private schedulePull(uri: string, delay: number) {
    clearTimeout(this.pulls.get(uri));
    this.pulls.set(
      uri,
      setTimeout(() => void this.pull(uri), delay),
    );
  }

  private async pull(uri: string) {
    this.pulls.delete(uri);
    const provider = this.client.serverCapabilities?.diagnosticProvider;
    if (!provider || !this.client.connected) return;
    let report: lsp.DocumentDiagnosticReport;
    try {
      report = await this.client.request<
        lsp.DocumentDiagnosticParams,
        lsp.DocumentDiagnosticReport
      >('textDocument/diagnostic', {
        textDocument: { uri },
        identifier: 'identifier' in provider ? provider.identifier : undefined,
        previousResultId: this.resultIds.get(uri),
      });
    } catch {
      // The server may cancel a pull it's busy with; the next change asks again.
      return;
    }
    const apply = (fileUri: string, items: lsp.Diagnostic[]) => {
      const params = { uri: fileUri, diagnostics: items };
      this.diagnose(params);
      const note = JSON.stringify({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params,
      });
      for (const handler of this.handlers) handler(note);
    };
    if (report.kind === 'full') {
      if (report.resultId) this.resultIds.set(uri, report.resultId);
      apply(uri, report.items);
    }
    for (const [related, value] of Object.entries(report.relatedDocuments ?? {})) {
      if (value.kind === 'full') apply(related, value.items);
    }
  }

  private diagnose(params: lsp.PublishDiagnosticsParams) {
    const path = uriToPath(params.uri);
    if (!path) return;
    this.diagnostics.set(params.uri, params.diagnostics);
    const problems: Problem[] = params.diagnostics.map((d) => ({
      path,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
      message: typeof d.message === 'string' ? d.message : d.message.value,
      source: d.source ?? this.def.name,
    }));
    if (problems.length) this.problems.set(pathKey(path), problems);
    else this.problems.delete(pathKey(path));
    setProblems(`lsp:${this.key}`, [...this.problems.values()].flat());
  }

  private clearProblems() {
    this.problems.clear();
    this.diagnostics.clear();
    setProblems(`lsp:${this.key}`, []);
  }

  private onProgress(params: Progress) {
    const value = params.value;
    if (!value || typeof value !== 'object' || !('kind' in value)) return;
    if (value.kind === 'end') {
      this.progress.delete(params.token);
    } else {
      const title =
        value.kind === 'begin' ? value.title : (this.progress.get(params.token)?.title ?? '');
      const pct = value.percentage !== undefined ? ` ${Math.round(value.percentage)}%` : '';
      const detail = `${title}${value.message ? ` ${value.message}` : ''}${pct}`.trim();
      this.progress.set(params.token, { title, detail });
    }
    const first = this.progress.values().next().value;
    this.update({ progress: first?.detail ?? null });
  }

  private exited(code: number | null) {
    this.session = null;
    if (this.exitedEarly) {
      const reject = this.exitedEarly;
      this.exitedEarly = null;
      this.client.disconnect();
      this.clearProblems();
      this.update({
        state: 'failed',
        progress: null,
        error: `It stopped with exit code ${code ?? 'unknown'}.`,
      });
      reject(code);
      return;
    }
    this.client.disconnect();
    this.clearProblems();
    this.progress.clear();
    if (this.stopping) {
      this.update({ state: 'stopped', progress: null });
      return;
    }
    this.log(`[lathe] the server stopped (exit code ${code ?? 'unknown'})`);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < RESTART_WINDOW_MS), now];
    if (this.crashes.length > MAX_RESTARTS) {
      this.update({
        state: 'failed',
        progress: null,
        error: `It stopped with exit code ${code ?? 'unknown'}.`,
      });
      notify('error', `${this.def.name} keeps stopping.`, {
        detail: this.recentLog.slice(-4).join('\n'),
        actions: [
          { label: 'Restart', run: () => void this.restart() },
          { label: 'Show output', run: () => showOutput(this.outputChannel) },
        ],
      });
      return;
    }
    this.update({ state: 'restarting', progress: null });
    const delay = 400 * 2 ** (this.crashes.length - 1);
    setTimeout(() => {
      if (this.stopping) return;
      this.start().catch((err: unknown) => {
        this.update({ state: 'failed', error: errorMessage(err) });
      });
    }, delay);
  }

  /** The file was saved (rust-analyzer runs its checks then). */
  didSave(path: string) {
    if (this.state !== 'running') return;
    const file = this.client.workspace.getFile(pathToUri(path));
    if (file) this.client.notification('textDocument/didSave', { textDocument: { uri: file.uri } });
  }

  /** Files changed on disk (created, edited by another program, deleted). */
  filesChanged(changes: FsChange[]) {
    if (this.state !== 'running') return;
    const events = changes
      .filter(
        (c) =>
          (c.kind === 'created' || c.kind === 'changed' || c.kind === 'removed') &&
          isUnder(c.path, this.root),
      )
      .map((c) => ({
        uri: pathToUri(c.path),
        type: c.kind === 'created' ? 1 : c.kind === 'removed' ? 3 : 2,
      }));
    if (events.length)
      this.client.notification('workspace/didChangeWatchedFiles', { changes: events });
  }
}

export function showOutput(channel: string) {
  void import('../services/output').then(({ useOutput }) =>
    useOutput.setState({ active: channel }),
  );
  showPanel('output');
}
