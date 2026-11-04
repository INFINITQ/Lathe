// The API a Lathe plugin gets: `export function activate(lathe: Lathe)` in the module its
// lathe-plugin.json names as "main". Every call goes to Lathe's window and resolves with the
// answer, so most return promises. docs/plugins.md is the guide.

export interface Disposable {
  dispose(): void;
}

export interface QuickPickItem {
  label: string;
  description?: string;
}

export interface StatusBarItem {
  text: string;
  tooltip: string | undefined;
  /** A command to run when it's clicked. */
  command: string | undefined;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface ActiveEditor {
  /** Null for a file that hasn't been saved yet. */
  path: string | null;
  /** Lathe's language id: "python", "typescript", "markdown"… */
  languageId: string;
  text: string;
  /** Offsets into `text`. */
  selection: { from: number; to: number };
  /** The cursor's line, from 1. */
  line: number;
}

export interface CompletionRequest {
  language: string;
  text: string;
  offset: number;
  line: number;
  column: number;
  /** The word before the cursor. */
  word: string;
}

export interface CompletionItem {
  label: string;
  detail?: string;
  /** What to insert, when it isn't the label. */
  insertText?: string;
  /** "function", "variable", "keyword", "text"… (picks the icon). */
  kind?: string;
}

export interface HoverRequest {
  language: string;
  text: string;
  offset: number;
  word: string;
}

export interface Lathe {
  readonly plugin: { readonly id: string; readonly version: string };

  commands: {
    /** Handles a command (declare it in contributes.commands to give it a title in the palette). */
    register(command: string, run: (...args: unknown[]) => unknown): Disposable;
    /** Runs any command, Lathe's own included ("file.save", "view.toggleTerminal"…). */
    execute<T = unknown>(command: string, ...args: unknown[]): Promise<T>;
  };

  window: {
    /** Resolves with the action you clicked, if any. */
    showInformation(message: string, ...actions: string[]): Promise<string | null>;
    showWarning(message: string, ...actions: string[]): Promise<string | null>;
    showError(message: string, ...actions: string[]): Promise<string | null>;
    showQuickPick(
      items: (string | QuickPickItem)[],
      options?: { placeholder?: string },
    ): Promise<string | null>;
    showInputBox(options?: {
      placeholder?: string;
      value?: string;
      prompt?: string;
    }): Promise<string | null>;
    createStatusBarItem(options?: { alignment?: 'left' | 'right' }): StatusBarItem;
  };

  editor: {
    active(): Promise<ActiveEditor | null>;
    /** Called with the active editor whenever it, its text or its selection changes. */
    onDidChange(listener: (editor: ActiveEditor | null) => void): Disposable;
    insert(text: string): Promise<void>;
    replaceSelection(text: string): Promise<void>;
  };

  /** Files in the open folder. Reading needs "workspace.read"; writing "workspace.write". */
  workspace: {
    root(): Promise<string | null>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, text: string): Promise<void>;
    /** Fuzzy-matches file names (as Ctrl+P does). */
    findFiles(query: string, limit?: number): Promise<string[]>;
  };

  languages: {
    /** `language` is a language id, or "*" for every language. Answer within a second. */
    registerCompletionProvider(
      language: string,
      provide: (
        request: CompletionRequest,
      ) => (string | CompletionItem)[] | Promise<(string | CompletionItem)[]>,
    ): Disposable;
    registerHoverProvider(
      language: string,
      provide: (request: HoverRequest) => string | null | Promise<string | null>,
    ): Disposable;
  };

  /** Needs "terminal". The command runs in PowerShell, in a terminal you can see. */
  terminal: {
    run(command: string, options?: { cwd?: string; title?: string }): Promise<void>;
  };

  settings: {
    /** Your settings first, then the default the plugin declared in contributes.settings. */
    get<T = unknown>(key: string): Promise<T | null>;
  };
}
