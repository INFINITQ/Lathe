// The only module that talks to Tauri. Everything else goes through `backend()`, so tests and a
// plain browser (`pnpm --filter @lathe/app dev:web`) run against `fakeBackend()` instead, which
// keeps a small demo project in memory.
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { UserAttentionType, getCurrentWindow } from '@tauri-apps/api/window';
import { basename, dirname, join } from './paths';

export interface Stamp {
  mtime: number;
  size: number;
}

/** How a text file is stored on disk. */
export interface TextFormat {
  encoding: string;
  bom: boolean;
  crlf: boolean;
}

export interface OpenedText {
  text: string;
  format: TextFormat;
  stamp: Stamp;
  readOnly: boolean;
}

export interface DirEntry {
  name: string;
  dir: boolean;
  link: boolean;
  hidden: boolean;
  size: number;
  mtime: number;
}

export interface StatInfo {
  dir: boolean;
  size: number;
  mtime: number;
  readOnly: boolean;
}

export type ChangeKind = 'created' | 'changed' | 'removed' | 'rescan' | 'git';

export interface FsChange {
  kind: ChangeKind;
  path: string;
}

export interface SettingsSnapshot {
  path: string;
  values: Record<string, unknown>;
  /** Set while the file doesn't parse; `values` are the last good ones. */
  error: string | null;
}

export interface AllSettings {
  user: SettingsSnapshot;
  workspace: SettingsSnapshot | null;
}

export type SettingsScope = 'user' | 'workspace';

export interface OpenedFolder {
  root: string;
  name: string;
  settings: SettingsSnapshot;
  recent: string[];
}

export interface FileMatch {
  path: string;
  score: number;
  indices: number[];
}

export interface FoundFiles {
  matches: FileMatch[];
  complete: boolean;
  total: number;
}

/** What Lathe was started with: `lathe <folder or files…>`. */
export interface Launch {
  args: string[];
  cwd: string;
}

/** Start-up data Rust injects before the page loads (`window.__LATHE_BOOT__`). */
export interface Boot {
  systemDark: boolean;
  settings: SettingsSnapshot;
  session: unknown;
  recent: string[];
  launch: Launch;
  dataDir: string;
}

export interface SystemInfo {
  appVersion: string;
  coreVersion: string;
  webviewVersion: string;
  dataDir: string;
}

/** An error from a Rust command: `{ kind, message }`. */
export interface BackendError {
  kind: string;
  message: string;
}

export type CaptionState = 'enter' | 'leave' | 'press' | 'release';

/** Window controls for the custom title bar. */
export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  /** Asks to close: the close handler runs first (it saves the session). */
  close(): void;
  isMaximized(): Promise<boolean>;
  /** Flashes the taskbar button (something finished or waits for you). */
  requestAttention(): void;
  onResized(listener: () => void): () => void;
  /** Tells Rust where the HTML maximize button is, for Windows 11's Snap Layouts. */
  reportMaximizeRect(rect: { right: number; top: number; width: number; height: number }): void;
  /** Hover and press state from the native Snap Layouts overlay. */
  onCaption(listener: (state: CaptionState) => void): () => void;
  /** Runs `handler` before the window closes (by any means); it closes unless that says false. */
  onCloseRequested(handler: () => Promise<boolean>): () => void;
  setTitle(title: string): Promise<void>;
}

export interface FsBackend {
  readText(path: string): Promise<OpenedText>;
  writeText(
    path: string,
    text: string,
    format: TextFormat | null,
    expected: Stamp | null,
    force: boolean,
  ): Promise<Stamp>;
  newFileFormat(path: string): Promise<TextFormat>;
  readBytes(path: string): Promise<ArrayBuffer>;
  readDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<StatInfo | null>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  delete(paths: string[], toTrash: boolean): Promise<void>;
  copyInto(sources: string[], targetDir: string): Promise<string[]>;
  moveInto(sources: string[], targetDir: string): Promise<string[]>;
  reveal(path: string): Promise<void>;
}

export interface DialogBackend {
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  saveAs(defaultPath?: string): Promise<string | null>;
}

export interface WorkspaceBackend {
  /** Opens a folder; changes on disk arrive on `onChanges`. */
  open(path: string, onChanges: (changes: FsChange[]) => void): Promise<OpenedFolder>;
  close(): Promise<void>;
  findFiles(query: string, limit?: number): Promise<FoundFiles>;
}

export interface SettingsBackend {
  get(): Promise<AllSettings>;
  set(scope: SettingsScope, patch: Record<string, unknown>): Promise<AllSettings>;
  reload(): Promise<AllSettings>;
  onChange(listener: (settings: AllSettings) => void): () => void;
}

export interface SessionBackend {
  save(session: unknown): Promise<void>;
  saveBuffer(id: string, text: string): Promise<void>;
  loadBuffer(id: string): Promise<string | null>;
  removeBuffer(id: string): Promise<void>;
  pruneBuffers(keep: string[]): Promise<void>;
  recent(): Promise<string[]>;
  removeRecent(path: string): Promise<string[]>;
}

export interface TerminalInfo {
  id: string;
  /** "PowerShell", "Git Bash", "Run: main.py"… */
  title: string;
  cwd: string;
  /** What it's for ("run" for the Run button). */
  tag: string | null;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
}

export type TerminalEvent =
  { type: 'output'; data: string } | { type: 'exit'; code: number | null };

export interface TerminalProfile {
  id: string;
  title: string;
  path: string;
}

export interface Toolchain {
  id: string;
  name: string;
  languages: string;
  path: string | null;
  version: string | null;
  winget: string | null;
}

export interface Captured {
  code: number | null;
  output: string;
  elapsedMs: number;
  timedOut: boolean;
}

export interface TerminalBackend {
  profiles(): Promise<TerminalProfile[]>;
  open(options: {
    profile?: string;
    cwd?: string;
    cols: number;
    rows: number;
    tag?: string;
  }): Promise<TerminalInfo>;
  /** Runs a program in a new terminal (the Run button). */
  run(options: {
    title: string;
    program: string;
    args: string[];
    cwd: string;
    env: [string, string][];
    cols: number;
    rows: number;
    tag?: string;
  }): Promise<TerminalInfo>;
  attach(id: string, onEvent: (event: TerminalEvent) => void): Promise<void>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  list(): Promise<TerminalInfo[]>;
}

export interface ToolchainBackend {
  detect(): Promise<Toolchain[]>;
  /** The variables Visual Studio's developer environment sets, or null without MSVC. */
  msvcEnv(): Promise<[string, string][] | null>;
  refreshPath(): Promise<void>;
  which(name: string): Promise<string | null>;
  /** Runs a program to completion and returns its output (compile steps). */
  capture(options: {
    program: string;
    args: string[];
    cwd: string;
    env: [string, string][];
    timeoutMs?: number;
  }): Promise<Captured>;
  wingetArgs(packageId: string): Promise<string[]>;
  isTrusted(folder: string): Promise<boolean>;
  setTrusted(folder: string, trusted: boolean): Promise<void>;
}

/** A folder search (Rust: lathe_core::search::Query). */
export interface SearchQuery {
  pattern: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  /** VS Code-style globs: `src`, `*.ts`, `./docs/**`. */
  include: string[];
  exclude: string[];
  useIgnoreFiles: boolean;
  maxResults: number;
}

/** One match: 1-based lines, 0-based UTF-16 columns. */
export interface SearchMatch {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
  previewStart: number;
  previewLen: number;
}

export interface FileMatches {
  path: string;
  matches: SearchMatch[];
}

export type SearchEvent =
  | { type: 'files'; files: FileMatches[] }
  | {
      type: 'done';
      files: number;
      matches: number;
      limitHit: boolean;
      elapsedMs: number;
      error: string | null;
      /** Files that couldn't be opened, and the first one's error. */
      unreadable: number;
      firstUnreadable: string | null;
    };

/** A change to a document's text, in UTF-16 offsets. */
export interface SearchEdit {
  from: number;
  to: number;
  insert: string;
}

export interface Replaced {
  path: string;
  count: number;
  error: { kind: string; message: string } | null;
}

export interface SearchBackend {
  /** Searches the open folder; `unsaved` is [path, text] for open files with unsaved changes. */
  start(
    query: SearchQuery,
    unsaved: [string, string][],
    onEvent: (event: SearchEvent) => void,
    /** Searches in different slots run side by side ("view", "symbols"). */
    slot?: string,
  ): Promise<void>;
  cancel(slot?: string): Promise<void>;
  /** Replaces every match in files that aren't open, keeping their format. */
  replaceFiles(query: SearchQuery, replacement: string, paths: string[]): Promise<Replaced[]>;
  /** Replaces the one match at a line and column of a file on disk. */
  replaceAt(
    query: SearchQuery,
    replacement: string,
    path: string,
    line: number,
    column: number,
  ): Promise<number>;
  /** The edits that replace matches in an open document's text. */
  edits(query: SearchQuery, replacement: string, text: string, at?: number): Promise<SearchEdit[]>;
}

export type LspEvent =
  | { type: 'message'; data: string }
  | { type: 'log'; line: string }
  | { type: 'exit'; code: number | null };

export interface LspLaunch {
  program: string;
  args: string[];
  cwd: string;
  env: [string, string][];
}

export interface LspBackend {
  /** Starts a language server; its messages, stderr lines and exit arrive on `onEvent`. */
  start(
    launch: LspLaunch,
    onEvent: (event: LspEvent) => void,
  ): Promise<{ id: string; pid: number; program: string }>;
  send(id: string, message: string): Promise<void>;
  stop(id: string): Promise<void>;
  /** Where downloaded servers live (`<data>\\tools`). */
  toolsDir(): Promise<string>;
  /** Downloads an archive over HTTPS, checks its SHA-256 and unpacks it into tools\\<name>. */
  installArchive(name: string, url: string, sha256: string): Promise<string>;
}

export interface DebugBackend {
  /** Starts a debug adapter. With `stdio` Lathe speaks DAP on its stdin and stdout; otherwise its
   * output lines arrive as logs (an adapter's server, or an adapter that connects back). */
  spawn(
    launch: LspLaunch & { stdio: boolean },
    onEvent: (event: LspEvent) => void,
  ): Promise<{ id: string; pid: number; program: string }>;
  /** Connects to an adapter's server on 127.0.0.1, waiting while it starts. */
  connect(port: number, onEvent: (event: LspEvent) => void): Promise<string>;
  /** Opens a port on 127.0.0.1 for an adapter to connect back to. */
  listen(): Promise<{ id: string; port: number }>;
  /** Waits for the adapter to connect to a port from `listen`. */
  accept(id: string, onEvent: (event: LspEvent) => void): Promise<void>;
  send(id: string, message: string): Promise<void>;
  /** Closes a connection, or stops an adapter and everything it started. */
  close(id: string): Promise<void>;
}

/** lathe-plugin.json (docs/plugins.md). */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  engines: { lathe?: string | null };
  main?: string | null;
  activationEvents: string[];
  contributes: Record<string, unknown> | null;
  permissions: string[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  dir: string;
  enabled: boolean;
}

export interface StagedPlugin {
  stagingId: string;
  manifest: PluginManifest;
  /** The installed version it would replace. */
  replaces: string | null;
}

export interface PluginBackend {
  list(): Promise<InstalledPlugin[]>;
  /** Copies (folder), unpacks (zip) or clones (git) a plugin into staging. */
  stage(kind: 'folder' | 'zip' | 'git', source: string): Promise<StagedPlugin>;
  install(stagingId: string): Promise<PluginManifest>;
  discard(stagingId: string): Promise<void>;
  uninstall(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** A text file from a plugin's folder (its themes, snippets). */
  readText(id: string, path: string): Promise<string>;
}

/** A Jupyter kernelspec (kernel.json). */
export interface KernelSpecInfo {
  name: string;
  displayName: string;
  language: string;
  argv: string[];
  env: Record<string, string>;
  /** "signal" or "message". */
  interruptMode: string;
  /** The folder holding kernel.json. */
  dir: string;
}

export type KernelChannel = 'iopub' | 'shell' | 'stdin' | 'control';

export type KernelEvent =
  | {
      type: 'message';
      channel: KernelChannel;
      msgType: string;
      msgId: string;
      parentId: string | null;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }
  /** A line the kernel process printed itself (C-level output, crashes). */
  | { type: 'log'; line: string }
  /** The kernel ended on its own. */
  | { type: 'exit'; code: number | null };

export interface KernelBackend {
  /** Kernelspecs in Jupyter's folders, plus each environment's (`prefixes` are sys.prefix). */
  specs(prefixes: string[]): Promise<KernelSpecInfo[]>;
  /** Starts a kernel; resolves with its kernel_info reply once it answers. */
  start(
    launch: { argv: string[]; env: [string, string][]; cwd: string; interruptMode: string },
    onEvent: (event: KernelEvent) => void,
  ): Promise<{ id: string; info: Record<string, unknown> }>;
  /** Runs code; `msgId` is the caller's, so it can route outputs that arrive first. */
  execute(
    id: string,
    msgId: string,
    code: string,
    options?: { silent?: boolean; allowStdin?: boolean },
  ): Promise<void>;
  complete(id: string, code: string, cursorPos: number): Promise<Record<string, unknown>>;
  inspect(id: string, code: string, cursorPos: number): Promise<Record<string, unknown>>;
  /** Answers the kernel's input() prompt. */
  input(id: string, value: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  restart(id: string): Promise<Record<string, unknown>>;
  shutdown(id: string): Promise<void>;
}

/** One changed file: porcelain letters (M A D R C T U, . unchanged, ? untracked). */
export interface GitFileStatus {
  path: string;
  origPath: string | null;
  index: string;
  worktree: string;
  conflict: boolean;
}

export interface GitRepoStatus {
  root: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

/** A file's text at a revision (with \n line endings), and the format it's stored in. */
export interface GitBlob {
  text: string;
  format: TextFormat;
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  commit: string;
  subject: string;
  date: number;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: number;
  subject: string;
}

export interface GitBlameLine {
  line: number;
  hash: string;
  author: string;
  date: number;
  subject: string;
}

export interface GitBackend {
  /** The repository holding `folder`, or null. */
  status(folder: string): Promise<GitRepoStatus | null>;
  /** A file at `rev` ("HEAD", a commit, or "" for the index); null if it isn't there. */
  show(root: string, rev: string, path: string): Promise<GitBlob | null>;
  stage(root: string, files: string[]): Promise<void>;
  unstage(root: string, files: string[], hasHead: boolean): Promise<void>;
  discard(root: string, files: string[]): Promise<void>;
  /** Puts exact text in the index for one file (staging a single hunk). */
  setIndex(root: string, path: string, text: string, format: TextFormat): Promise<void>;
  commit(root: string, message: string, amend: boolean, all: boolean): Promise<string>;
  branches(root: string): Promise<GitBranch[]>;
  switchBranch(root: string, branch: string, create: boolean, start?: string): Promise<void>;
  deleteBranch(root: string, branch: string, force: boolean): Promise<void>;
  remote(root: string, action: 'fetch' | 'pull' | 'push', options: string[]): Promise<string>;
  log(root: string, path: string | null, limit: number): Promise<GitCommit[]>;
  blame(root: string, path: string, text: string): Promise<GitBlameLine[]>;
  stash(root: string, action: 'push' | 'pop' | 'list', message?: string): Promise<string>;
  init(folder: string): Promise<void>;
  clone(url: string, dest: string): Promise<string>;
  identity(root: string): Promise<{ name: string | null; email: string | null }>;
}

export interface HistoryEntry {
  id: string;
  time: number;
  size: number;
}

export interface HistoryBackend {
  /** Earlier saved versions of a file, newest first. */
  list(path: string): Promise<HistoryEntry[]>;
  read(path: string, id: string): Promise<string>;
}

export interface Backend {
  kind: 'tauri' | 'fake';
  terminal: TerminalBackend;
  toolchains: ToolchainBackend;
  search: SearchBackend;
  lsp: LspBackend;
  debug: DebugBackend;
  kernels: KernelBackend;
  plugins: PluginBackend;
  git: GitBackend;
  history: HistoryBackend;
  boot(): Boot;
  /** Shows the window; called once the first frame has painted. */
  appReady(): Promise<void>;
  systemInfo(): Promise<SystemInfo>;
  /** Keeps the native window background in step with the theme. */
  setWindowDark(dark: boolean): Promise<void>;
  openLink(url: string): Promise<void>;
  /** Lets a waiting `lathe --wait` return (its files' editors have closed). */
  releaseWait(marker: string): Promise<void>;
  /** VS Code's folder of your settings, keybindings and snippets, if it has one. */
  vscodeUserDir(): Promise<string | null>;
  /** A second launch (`lathe <path>`) handed its arguments over. */
  onOpen(listener: (launch: Launch) => void): () => void;
  /** Files or folders were dropped on the window from File Explorer. */
  onDrop(listener: (paths: string[]) => void): () => void;
  window: WindowControls;
  fs: FsBackend;
  dialogs: DialogBackend;
  workspace: WorkspaceBackend;
  settings: SettingsBackend;
  session: SessionBackend;
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Turns an async unlisten into a plain function that works even before `listen` resolves. */
export function unsubscriber(pending: Promise<() => void>): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  void pending.then((fn) => {
    if (stopped) fn();
    else stop = fn;
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  return unsubscriber(listen<T>(event, (e) => listener(e.payload)));
}

const EMPTY_SETTINGS: SettingsSnapshot = { path: '', values: {}, error: null };

export function tauriBackend(): Backend {
  const win = getCurrentWindow();
  return {
    kind: 'tauri',
    terminal: {
      profiles: () => invoke<TerminalProfile[]>('terminal_profiles'),
      open: (o) => invoke<TerminalInfo>('terminal_open', { ...o }),
      run: (o) => invoke<TerminalInfo>('terminal_run', { ...o }),
      attach: (id, onEvent) => {
        const channel = new Channel<TerminalEvent>();
        channel.onmessage = onEvent;
        return invoke('terminal_attach', { id, channel });
      },
      write: (id, data) => invoke('terminal_write', { id, data }),
      resize: (id, cols, rows) => invoke('terminal_resize', { id, cols, rows }),
      close: (id) => invoke('terminal_close', { id }),
      list: () => invoke<TerminalInfo[]>('terminals_list'),
    },
    toolchains: {
      detect: () => invoke<Toolchain[]>('toolchains_detect'),
      msvcEnv: () => invoke<[string, string][] | null>('toolchain_msvc_env'),
      refreshPath: () => invoke('path_refresh'),
      which: (name) => invoke<string | null>('program_which', { name }),
      capture: (o) => invoke<Captured>('run_capture', { ...o }),
      wingetArgs: (packageId) => invoke<string[]>('winget_args', { package: packageId }),
      isTrusted: (folder) => invoke<boolean>('trust_get', { folder }),
      setTrusted: (folder, trusted) => invoke('trust_set', { folder, trusted }),
    },
    search: {
      start: (query, unsaved, onEvent, slot) => {
        const channel = new Channel<SearchEvent>();
        channel.onmessage = onEvent;
        return invoke('search_start', { query, unsaved, slot: slot ?? null, channel });
      },
      cancel: (slot) => invoke('search_cancel', { slot: slot ?? null }),
      replaceFiles: (query, replacement, paths) =>
        invoke<Replaced[]>('search_replace_files', { query, replacement, paths }),
      replaceAt: (query, replacement, path, line, column) =>
        invoke<number>('search_replace_at', { query, replacement, path, line, column }),
      edits: (query, replacement, text, at) =>
        invoke<SearchEdit[]>('search_edits', { query, replacement, text, at: at ?? null }),
    },
    lsp: {
      start: (launch, onEvent) => {
        const channel = new Channel<LspEvent>();
        channel.onmessage = onEvent;
        return invoke<{ id: string; pid: number; program: string }>('lsp_start', {
          ...launch,
          channel,
        });
      },
      send: (id, message) => invoke('lsp_send', { id, message }),
      stop: (id) => invoke('lsp_stop', { id }),
      toolsDir: () => invoke<string>('tools_dir'),
      installArchive: (name, url, sha256) =>
        invoke<string>('tools_install_archive', { name, url, sha256 }),
    },
    debug: {
      spawn: (launch, onEvent) => {
        const channel = new Channel<LspEvent>();
        channel.onmessage = onEvent;
        return invoke<{ id: string; pid: number; program: string }>('dap_spawn', {
          ...launch,
          channel,
        });
      },
      connect: (port, onEvent) => {
        const channel = new Channel<LspEvent>();
        channel.onmessage = onEvent;
        return invoke<string>('dap_connect', { port, channel });
      },
      listen: () => invoke<{ id: string; port: number }>('dap_listen'),
      accept: (id, onEvent) => {
        const channel = new Channel<LspEvent>();
        channel.onmessage = onEvent;
        return invoke('dap_accept', { id, channel });
      },
      send: (id, message) => invoke('dap_send', { id, message }),
      close: (id) => invoke('dap_close', { id }),
    },
    plugins: {
      list: () => invoke<InstalledPlugin[]>('plugins_list'),
      stage: (kind, source) => invoke<StagedPlugin>('plugin_stage', { kind, source }),
      install: (stagingId) => invoke<PluginManifest>('plugin_install', { stagingId }),
      discard: (stagingId) => invoke('plugin_discard', { stagingId }),
      uninstall: (id) => invoke('plugin_uninstall', { id }),
      setEnabled: (id, enabled) => invoke('plugin_set_enabled', { id, enabled }),
      readText: (id, path) => invoke<string>('plugin_read_text', { id, path }),
    },
    kernels: {
      specs: (prefixes) => invoke<KernelSpecInfo[]>('kernel_specs', { prefixes }),
      start: (launch, onEvent) => {
        const channel = new Channel<KernelEvent>();
        channel.onmessage = onEvent;
        return invoke<{ id: string; info: Record<string, unknown> }>('kernel_start', {
          ...launch,
          channel,
        });
      },
      execute: (id, msgId, code, options) =>
        invoke('kernel_execute', {
          id,
          msgId,
          code,
          silent: options?.silent ?? false,
          allowStdin: options?.allowStdin ?? true,
        }),
      complete: (id, code, cursorPos) =>
        invoke<Record<string, unknown>>('kernel_complete', { id, code, cursorPos }),
      inspect: (id, code, cursorPos) =>
        invoke<Record<string, unknown>>('kernel_inspect', { id, code, cursorPos }),
      input: (id, value) => invoke('kernel_input', { id, value }),
      interrupt: (id) => invoke('kernel_interrupt', { id }),
      restart: (id) => invoke<Record<string, unknown>>('kernel_restart', { id }),
      shutdown: (id) => invoke('kernel_shutdown', { id }),
    },
    git: {
      status: (folder) => invoke<GitRepoStatus | null>('git_status', { folder }),
      show: (root, rev, path) => invoke<GitBlob | null>('git_show', { root, rev, path }),
      stage: (root, files) => invoke('git_stage', { root, files }),
      unstage: (root, files, hasHead) => invoke('git_unstage', { root, files, hasHead }),
      discard: (root, files) => invoke('git_discard', { root, files }),
      setIndex: (root, path, text, format) => invoke('git_set_index', { root, path, text, format }),
      commit: (root, message, amend, all) =>
        invoke<string>('git_commit', { root, message, amend, all }),
      branches: (root) => invoke<GitBranch[]>('git_branches', { root }),
      switchBranch: (root, branch, create, start) =>
        invoke('git_switch', { root, branch, create, start: start ?? null }),
      deleteBranch: (root, branch, force) => invoke('git_delete_branch', { root, branch, force }),
      remote: (root, action, options) => invoke<string>('git_remote', { root, action, options }),
      log: (root, path, limit) => invoke<GitCommit[]>('git_log', { root, path, limit }),
      blame: (root, path, text) => invoke<GitBlameLine[]>('git_blame', { root, path, text }),
      stash: (root, action, message) =>
        invoke<string>('git_stash', { root, action, message: message ?? null }),
      init: (folder) => invoke('git_init', { folder }),
      clone: (url, dest) => invoke<string>('git_clone', { url, dest }),
      identity: (root) =>
        invoke<{ name: string | null; email: string | null }>('git_identity', { root }),
    },
    history: {
      list: (path) => invoke<HistoryEntry[]>('history_list', { path }),
      read: (path, id) => invoke<string>('history_read', { path, id }),
    },
    boot: () =>
      window.__LATHE_BOOT__ ?? {
        systemDark: systemDark(),
        settings: EMPTY_SETTINGS,
        session: null,
        recent: [],
        launch: { args: [], cwd: '' },
        dataDir: '',
      },
    appReady: () => invoke('app_ready'),
    systemInfo: () => invoke<SystemInfo>('system_info'),
    setWindowDark: (dark) => invoke('window_set_dark', { dark }),
    openLink: (url) => invoke('open_link', { url }),
    releaseWait: (marker) => invoke('wait_release', { marker }),
    vscodeUserDir: () => invoke<string | null>('vscode_user_dir'),
    onOpen: (listener) => subscribe<Launch>('lathe://open', listener),
    onDrop: (listener) => subscribe<string[]>('lathe://drop', listener),
    window: {
      minimize: () => void win.minimize(),
      toggleMaximize: () => void win.toggleMaximize(),
      close: () => void win.close(),
      isMaximized: () => win.isMaximized(),
      requestAttention: () =>
        void win.requestUserAttention(UserAttentionType.Informational).catch(() => {}),
      onResized: (listener) => unsubscriber(win.onResized(() => listener())),
      reportMaximizeRect: (rect) => void invoke('caption_maximize_rect', { rect }),
      onCaption: (listener) => subscribe<CaptionState>('lathe://caption', listener),
      onCloseRequested: (handler) =>
        unsubscriber(
          win.onCloseRequested(async (event) => {
            event.preventDefault();
            let close = true;
            try {
              close = await handler();
            } catch (err) {
              console.error('Saving the session before closing failed', err);
            }
            if (close) await win.destroy();
          }),
        ),
      setTitle: (title) => invoke('window_set_title', { title }),
    },
    fs: {
      readText: (path) => invoke<OpenedText>('fs_read_text', { path }),
      writeText: (path, text, format, expected, force) =>
        invoke<Stamp>('fs_write_text', { path, text, format, expected, force }),
      newFileFormat: (path) => invoke<TextFormat>('fs_new_file_format', { path }),
      readBytes: (path) => invoke<ArrayBuffer>('fs_read_bytes', { path }),
      readDir: (path) => invoke<DirEntry[]>('fs_read_dir', { path }),
      stat: (path) => invoke<StatInfo | null>('fs_stat', { path }),
      createFile: (path) => invoke('fs_create_file', { path }),
      createDir: (path) => invoke('fs_create_dir', { path }),
      rename: (from, to) => invoke('fs_rename', { from, to }),
      delete: (paths, toTrash) => invoke('fs_delete', { paths, toTrash }),
      copyInto: (sources, targetDir) => invoke<string[]>('fs_copy_into', { sources, targetDir }),
      moveInto: (sources, targetDir) => invoke<string[]>('fs_move_into', { sources, targetDir }),
      reveal: (path) => invoke('fs_reveal', { path }),
    },
    dialogs: {
      pickFolder: () => invoke<string | null>('dialog_pick_folder'),
      pickFiles: () => invoke<string[]>('dialog_pick_files'),
      saveAs: (defaultPath) => invoke<string | null>('dialog_save_as', { defaultPath }),
    },
    workspace: {
      open: (path, onChanges) => {
        const events = new Channel<FsChange[]>();
        events.onmessage = onChanges;
        return invoke<OpenedFolder>('workspace_open', { path, events });
      },
      close: () => invoke('workspace_close'),
      findFiles: (query, limit) => invoke<FoundFiles>('workspace_find_files', { query, limit }),
    },
    settings: {
      get: () => invoke<AllSettings>('settings_get'),
      set: (scope, patch) => invoke<AllSettings>('settings_set', { scope, patch }),
      reload: () => invoke<AllSettings>('settings_reload'),
      onChange: (listener) => subscribe<AllSettings>('lathe://settings', listener),
    },
    session: {
      save: (session) => invoke('session_save', { session }),
      saveBuffer: (id, text) => invoke('buffer_save', { id, text }),
      loadBuffer: (id) => invoke<string | null>('buffer_load', { id }),
      removeBuffer: (id) => invoke('buffer_remove', { id }),
      pruneBuffers: (keep) => invoke('buffers_prune', { keep }),
      recent: () => invoke<string[]>('recent_folders'),
      removeRecent: (path) => invoke<string[]>('recent_remove', { path }),
    },
  };
}

const noop = () => {};

function backendError(kind: string, message: string): BackendError {
  return { kind, message };
}

/** The demo project the fake backend starts with. */
const DEMO_ROOT = 'C:\\demo\\fib';
const DEMO_FILES: Record<string, string> = {
  'src\\main.py':
    'from utils import fib\n\n\ndef main() -> None:\n    n = int(input("How many? "))\n    for i in range(n):\n        print(f"fib({i}) = {fib(i)}")\n\n\nif __name__ == "__main__":\n    main()\n',
  'src\\utils.py':
    'def fib(n: int) -> int:\n    """The n-th Fibonacci number."""\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n',
  'src\\fib.cpp':
    '#include <iostream>\n#include <vector>\n\nint main() {\n    std::vector<long long> f{0, 1};\n    for (int i = 2; i < 50; ++i) f.push_back(f[i - 1] + f[i - 2]);\n    for (auto x : f) std::cout << x << "\\n";\n}\n',
  'web\\index.js':
    "const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));\n\nconsole.log([...Array(10).keys()].map(fib).join(', '));\n",
  'README.md': '# fib\n\nThree ways to count rabbits: Python, C++ and JavaScript.\n',
  '.gitignore': 'build/\n__pycache__/\n',
};

/** An in-memory backend for tests and for running the UI in a plain browser. */
/** The fake backend's search pattern, or the reason it's invalid. */
function fakeRegex(query: SearchQuery): RegExp | string {
  const source = query.isRegex
    ? query.pattern
    : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(
      query.wholeWord ? `\\b(?:${source})\\b` : source,
      query.matchCase ? 'gm' : 'gim',
    );
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function fakeBackend(): Backend {
  type Node = { dir: boolean; text: string; mtime: number };
  const nodes = new Map<string, Node>();
  const key = (path: string) => path.toLowerCase();
  const put = (path: string, node: Node) => {
    nodes.set(key(path), node);
    const parent = dirname(path);
    if (parent !== path && !nodes.has(key(parent))) put(parent, { dir: true, text: '', mtime: 0 });
  };
  for (const [relative, text] of Object.entries(DEMO_FILES)) {
    put(join(DEMO_ROOT, relative), { dir: false, text, mtime: Date.now() });
  }
  const original = new Map<string, string>(); // lower-case key -> display path
  for (const relative of Object.keys(DEMO_FILES)) {
    let path = join(DEMO_ROOT, relative);
    while (path.length > 3) {
      original.set(key(path), path);
      path = dirname(path);
    }
  }
  original.set(key(DEMO_ROOT), DEMO_ROOT);
  const displayPath = (path: string) => original.get(key(path)) ?? path;
  const children = (dir: string) => {
    const prefix = key(dir).replace(/\\?$/, '\\');
    return [...nodes.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('\\'))
      .map((k) => displayPath(k));
  };
  const get = (path: string) => {
    const node = nodes.get(key(path));
    if (!node) throw backendError('notFound', `${basename(path)} doesn't exist.`);
    return node;
  };
  let watcher: ((changes: FsChange[]) => void) | undefined;
  const notify = (kind: ChangeKind, path: string) => watcher?.([{ kind, path }]);
  let settings: AllSettings = {
    user: { path: 'C:\\fake\\settings.json', values: {}, error: null },
    workspace: null,
  };
  const buffers = new Map<string, string>();
  let recent: string[] = [DEMO_ROOT];
  const settingsListeners = new Set<(s: AllSettings) => void>();

  const fs: FsBackend = {
    readText: async (path) => {
      const node = get(path);
      if (node.dir) throw backendError('invalid', "That's a folder, not a file.");
      return {
        text: node.text,
        format: { encoding: 'UTF-8', bom: false, crlf: false },
        stamp: { mtime: node.mtime, size: node.text.length },
        readOnly: false,
      };
    },
    writeText: async (path, text) => {
      const mtime = Date.now();
      const exists = nodes.has(key(path));
      original.set(key(path), path);
      put(path, { dir: false, text, mtime });
      notify(exists ? 'changed' : 'created', path);
      return { mtime, size: text.length };
    },
    newFileFormat: async () => ({ encoding: 'UTF-8', bom: false, crlf: false }),
    readBytes: async (path) => new TextEncoder().encode(get(path).text).buffer as ArrayBuffer,
    readDir: async (path) => {
      get(path);
      return children(path)
        .map((child) => {
          const node = get(child);
          return {
            name: basename(child),
            dir: node.dir,
            link: false,
            hidden: false,
            size: node.text.length,
            mtime: node.mtime,
          };
        })
        .sort((a, b) =>
          a.dir === b.dir
            ? a.name.localeCompare(b.name, undefined, { numeric: true })
            : a.dir
              ? -1
              : 1,
        );
    },
    stat: async (path) => {
      const node = nodes.get(key(path));
      return node
        ? { dir: node.dir, size: node.text.length, mtime: node.mtime, readOnly: false }
        : null;
    },
    createFile: async (path) => {
      if (nodes.has(key(path))) throw backendError('exists', `${basename(path)} already exists.`);
      original.set(key(path), path);
      put(path, { dir: false, text: '', mtime: Date.now() });
      notify('created', path);
    },
    createDir: async (path) => {
      if (nodes.has(key(path))) throw backendError('exists', `${basename(path)} already exists.`);
      original.set(key(path), path);
      put(path, { dir: true, text: '', mtime: Date.now() });
      notify('created', path);
    },
    rename: async (from, to) => {
      const moved = [...nodes.entries()].filter(
        ([k]) => k === key(from) || k.startsWith(`${key(from)}\\`),
      );
      for (const [k, node] of moved) {
        nodes.delete(k);
        const next = to + displayPath(k).slice(from.length);
        original.set(key(next), next);
        nodes.set(key(next), node);
      }
      notify('removed', from);
      notify('created', to);
    },
    delete: async (paths) => {
      for (const path of paths) {
        for (const k of [...nodes.keys()]) {
          if (k === key(path) || k.startsWith(`${key(path)}\\`)) nodes.delete(k);
        }
        notify('removed', path);
      }
    },
    copyInto: async (sources, targetDir) => {
      const created: string[] = [];
      for (const source of sources) {
        let target = join(targetDir, basename(source));
        if (nodes.has(key(target))) target = target.replace(/(\.[^.\\]+)?$/, ' copy$1');
        original.set(key(target), target);
        put(target, { ...get(source) });
        created.push(target);
        notify('created', target);
      }
      return created;
    },
    moveInto: async (sources, targetDir) => {
      const moved: string[] = [];
      for (const source of sources) {
        const target = join(targetDir, basename(source));
        await fs.rename(source, target);
        moved.push(target);
      }
      return moved;
    },
    reveal: async () => {},
  };

  const fakeTerminals: TerminalInfo[] = [];
  return {
    kind: 'fake',
    terminal: {
      profiles: async () => [{ id: 'powershell', title: 'PowerShell', path: 'powershell.exe' }],
      open: async (o) => {
        const info: TerminalInfo = {
          id: crypto.randomUUID(),
          title: 'PowerShell',
          cwd: o.cwd ?? 'C:\\',
          tag: o.tag ?? null,
          running: true,
          exitCode: null,
          createdAt: Date.now(),
        };
        fakeTerminals.push(info);
        return info;
      },
      run: async (o) => {
        const info: TerminalInfo = {
          id: crypto.randomUUID(),
          title: o.title,
          cwd: o.cwd,
          tag: o.tag ?? null,
          running: false,
          exitCode: 0,
          createdAt: Date.now(),
        };
        fakeTerminals.push(info);
        return info;
      },
      attach: async (_id, onEvent) => {
        onEvent({ type: 'output', data: 'The fake backend has no real terminals.\r\n' });
      },
      write: async () => {},
      resize: async () => {},
      close: async (id) => {
        const at = fakeTerminals.findIndex((t) => t.id === id);
        if (at >= 0) fakeTerminals.splice(at, 1);
      },
      list: async () => [...fakeTerminals],
    },
    toolchains: {
      detect: async () => [
        {
          id: 'python',
          name: 'Python',
          languages: 'Python',
          path: 'python.exe',
          version: 'Python 3.14.7',
          winget: 'Python.Python.3.13',
        },
        {
          id: 'gcc',
          name: 'MinGW (g++)',
          languages: 'C, C++',
          path: null,
          version: null,
          winget: 'BrechtSanders.WinLibs.POSIX.UCRT',
        },
      ],
      msvcEnv: async () => null,
      refreshPath: async () => {},
      which: async (name) => name,
      capture: async () => ({ code: 0, output: '', elapsedMs: 1, timedOut: false }),
      wingetArgs: async (id) => ['install', '--id', id, '--exact'],
      isTrusted: async () => true,
      setTrusted: async () => {},
    },
    search: {
      // A plain JavaScript version of the Rust search, over the demo files.
      start: async (query, unsaved, onEvent) => {
        const started = Date.now();
        const re = fakeRegex(query);
        if (typeof re === 'string') {
          onEvent({
            type: 'done',
            files: 0,
            matches: 0,
            limitHit: false,
            elapsedMs: 0,
            error: re,
            unreadable: 0,
            firstUnreadable: null,
          });
          return;
        }
        const open = new Map(unsaved.map(([path, text]) => [key(path), text]));
        const files: FileMatches[] = [];
        let total = 0;
        for (const [k, node] of nodes) {
          if (node.dir) continue;
          const matches: SearchMatch[] = [];
          (open.get(k) ?? node.text).split('\n').forEach((line, i) => {
            for (const m of line.matchAll(re)) {
              if (!m[0]) continue;
              const indent = line.length - line.trimStart().length;
              const from = m.index < indent ? 0 : indent;
              matches.push({
                line: i + 1,
                column: m.index,
                endLine: i + 1,
                endColumn: m.index + m[0].length,
                preview: line.slice(from),
                previewStart: m.index - from,
                previewLen: m[0].length,
              });
            }
          });
          total += matches.length;
          if (matches.length) files.push({ path: displayPath(k), matches });
        }
        onEvent({ type: 'files', files });
        onEvent({
          type: 'done',
          files: files.length,
          matches: total,
          limitHit: false,
          elapsedMs: Date.now() - started,
          error: null,
          unreadable: 0,
          firstUnreadable: null,
        });
      },
      cancel: async () => {},
      replaceFiles: async (query, replacement, paths) =>
        paths.map((path) => {
          const node = get(path);
          const re = fakeRegex(query);
          if (typeof re === 'string')
            return { path, count: 0, error: { kind: 'pattern', message: re } };
          const count = [...node.text.matchAll(re)].length;
          node.text = query.isRegex
            ? node.text.replace(re, replacement)
            : node.text.replace(re, () => replacement);
          node.mtime = Date.now();
          notify('changed', path);
          return { path, count, error: null };
        }),
      replaceAt: async () => 0,
      edits: async (query, replacement, text, at) => {
        const re = fakeRegex(query);
        if (typeof re === 'string') throw backendError('pattern', re);
        return [...text.matchAll(re)]
          .filter((m) => at === undefined || m.index === at)
          .map((m) => ({
            from: m.index,
            to: m.index + m[0].length,
            insert: query.isRegex
              ? m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), replacement)
              : replacement,
          }));
      },
    },
    lsp: {
      start: async () => {
        throw backendError('notAvailable', 'Language servers need the desktop app.');
      },
      send: async () => {},
      stop: async () => {},
      toolsDir: async () => 'C:\\fake\\tools',
      installArchive: async () => {
        throw backendError('notAvailable', 'Downloads need the desktop app.');
      },
    },
    debug: {
      spawn: async () => {
        throw backendError('notAvailable', 'Debugging needs the desktop app.');
      },
      connect: async () => {
        throw backendError('notAvailable', 'Debugging needs the desktop app.');
      },
      listen: async () => {
        throw backendError('notAvailable', 'Debugging needs the desktop app.');
      },
      accept: async () => {},
      send: async () => {},
      close: async () => {},
    },
    plugins: {
      list: async () => [],
      stage: async () => {
        throw backendError('notAvailable', 'Plugins need the desktop app.');
      },
      install: async () => {
        throw backendError('notAvailable', 'Plugins need the desktop app.');
      },
      discard: async () => {},
      uninstall: async () => {},
      setEnabled: async () => {},
      readText: async () => '',
    },
    kernels: {
      specs: async () => [],
      start: async () => {
        throw backendError('notAvailable', 'Notebooks need the desktop app.');
      },
      execute: async () => {},
      complete: async () => ({ matches: [], cursor_start: 0, cursor_end: 0 }),
      inspect: async () => ({ found: false }),
      input: async () => {},
      interrupt: async () => {},
      restart: async () => ({}),
      shutdown: async () => {},
    },
    git: {
      status: async () => null,
      show: async () => null,
      stage: async () => {},
      unstage: async () => {},
      discard: async () => {},
      setIndex: async () => {},
      commit: async () => '',
      branches: async () => [],
      switchBranch: async () => {},
      deleteBranch: async () => {},
      remote: async () => '',
      log: async () => [],
      blame: async () => [],
      stash: async () => '',
      init: async () => {},
      clone: async () => '',
      identity: async () => ({ name: null, email: null }),
    },
    history: {
      list: async () => [],
      read: async () => '',
    },
    boot: () => ({
      systemDark: systemDark(),
      settings: settings.user,
      session: null,
      recent,
      launch: { args: [], cwd: '' },
      dataDir: 'C:\\fake',
    }),
    appReady: async () => {},
    systemInfo: async () => ({
      appVersion: '0.0.0-fake',
      coreVersion: '0.0.0-fake',
      webviewVersion: '',
      dataDir: 'C:\\fake',
    }),
    setWindowDark: async () => {},
    openLink: async () => {},
    releaseWait: async () => {},
    vscodeUserDir: async () => null,
    onOpen: () => noop,
    onDrop: () => noop,
    window: {
      minimize: noop,
      toggleMaximize: noop,
      close: noop,
      isMaximized: async () => false,
      requestAttention: noop,
      onResized: () => noop,
      reportMaximizeRect: noop,
      onCaption: () => noop,
      onCloseRequested: () => noop,
      setTitle: async (title) => {
        document.title = title;
      },
    },
    fs,
    dialogs: {
      pickFolder: async () => DEMO_ROOT,
      pickFiles: async () => [],
      saveAs: async (defaultPath) => defaultPath ?? join(DEMO_ROOT, 'untitled.txt'),
    },
    workspace: {
      open: async (path, onChanges) => {
        get(path);
        watcher = onChanges;
        recent = [path, ...recent.filter((p) => key(p) !== key(path))];
        settings = {
          ...settings,
          workspace: { path: join(path, '.lathe\\settings.json'), values: {}, error: null },
        };
        return {
          root: displayPath(path),
          name: basename(path),
          settings: settings.workspace!,
          recent,
        };
      },
      close: async () => {
        watcher = undefined;
        settings = { ...settings, workspace: null };
      },
      findFiles: async (query, limit = 60) => {
        const files = [...nodes.entries()]
          .filter(([, node]) => !node.dir)
          .map(([k]) =>
            displayPath(k)
              .slice(DEMO_ROOT.length + 1)
              .replaceAll('\\', '/'),
          );
        const q = query.toLowerCase().replaceAll('\\', '/');
        const matches = files
          .filter((f) => {
            let at = 0;
            for (const c of q) {
              at = f.toLowerCase().indexOf(c, at);
              if (at < 0) return false;
              at++;
            }
            return true;
          })
          .slice(0, limit)
          .map((path) => ({ path, score: 1, indices: [] }));
        return { matches, complete: true, total: files.length };
      },
    },
    settings: {
      get: async () => settings,
      set: async (scope, patch) => {
        const current = scope === 'user' ? settings.user : settings.workspace;
        if (!current) throw backendError('invalid', 'Open a folder first.');
        const values = { ...current.values };
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete values[k];
          else values[k] = v;
        }
        settings =
          scope === 'user'
            ? { ...settings, user: { ...current, values } }
            : { ...settings, workspace: { ...current, values } };
        settingsListeners.forEach((l) => l(settings));
        return settings;
      },
      reload: async () => settings,
      onChange: (listener) => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    },
    session: {
      save: async () => {},
      saveBuffer: async (id, text) => void buffers.set(id, text),
      loadBuffer: async (id) => buffers.get(id) ?? null,
      removeBuffer: async (id) => void buffers.delete(id),
      pruneBuffers: async () => {},
      recent: async () => recent,
      removeRecent: async (path) => (recent = recent.filter((p) => key(p) !== key(path))),
    },
  };
}

let current: Backend | undefined;

export function backend(): Backend {
  current ??=
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      ? tauriBackend()
      : fakeBackend();
  return current;
}

/** Tests swap in their own backend. */
export function setBackend(next: Backend) {
  current = next;
}

/** A readable message from whatever a backend call threw. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

/** The `kind` of a backend error ("conflict", "notFound"…), or "unknown". */
export function errorKind(err: unknown): string {
  if (err && typeof err === 'object' && 'kind' in err) return String(err.kind);
  return 'unknown';
}
