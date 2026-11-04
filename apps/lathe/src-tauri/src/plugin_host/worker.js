// Lathe's plugin runtime, inside the plugin's Worker: the `lathe` API (each call goes to
// Lathe's page, which checks the plugin's permissions), then the plugin's own module, started
// with activate(lathe). Lathe fills in __PLUGIN__ when it serves this file.

/* global __PLUGIN__, postMessage, self, console */

const PLUGIN = __PLUGIN__;

let seq = 0;
const pending = new Map();
/** Command and provider handlers, by name ("command:<id>", "provider:<id>"). */
const handlers = new Map();
const listeners = new Map();

function call(method, params = {}) {
  const id = ++seq;
  postMessage({ type: 'call', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const disposable = (dispose) => ({ dispose });
let nextId = 0;

function on(event, listener, subscribe) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
    void call(subscribe);
  }
  set.add(listener);
  return disposable(() => set.delete(listener));
}

function report(err) {
  postMessage({
    type: 'log',
    level: 'error',
    message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
  });
}

function statusBarItem(options = {}) {
  const id = `status${++nextId}`;
  const state = {
    text: '',
    tooltip: '',
    command: undefined,
    visible: false,
    alignment: options.alignment === 'left' ? 'left' : 'right',
  };
  const sync = () => void call('statusBar.set', { id, ...state });
  const field = (key) => ({
    get: () => state[key],
    set: (value) => {
      state[key] = value === undefined ? undefined : String(value);
      if (state.visible) sync();
    },
  });
  const item = {
    show() {
      state.visible = true;
      sync();
    },
    hide() {
      state.visible = false;
      sync();
    },
    dispose() {
      void call('statusBar.remove', { id });
    },
  };
  for (const key of ['text', 'tooltip', 'command']) Object.defineProperty(item, key, field(key));
  return item;
}

function provider(kind, language, provide) {
  const id = `${kind}${++nextId}`;
  handlers.set(`provider:${id}`, provide);
  void call('languages.register', { kind, id, language });
  return disposable(() => {
    handlers.delete(`provider:${id}`);
    void call('languages.unregister', { id });
  });
}

const lathe = Object.freeze({
  plugin: Object.freeze({ id: PLUGIN.id, version: PLUGIN.version }),
  commands: {
    register(command, run) {
      handlers.set(`command:${command}`, run);
      void call('commands.register', { command });
      return disposable(() => {
        handlers.delete(`command:${command}`);
        void call('commands.unregister', { command });
      });
    },
    execute: (command, ...args) => call('commands.execute', { command, args }),
  },
  window: {
    showInformation: (message, ...actions) =>
      call('window.notify', { kind: 'info', message, actions }),
    showWarning: (message, ...actions) =>
      call('window.notify', { kind: 'warning', message, actions }),
    showError: (message, ...actions) => call('window.notify', { kind: 'error', message, actions }),
    showQuickPick: (items, options = {}) =>
      call('window.quickPick', { items, placeholder: options.placeholder }),
    showInputBox: (options = {}) => call('window.inputBox', options),
    createStatusBarItem: statusBarItem,
  },
  editor: {
    active: () => call('editor.active'),
    onDidChange: (listener) => on('editor.changed', listener, 'editor.watch'),
    insert: (text) => call('editor.insert', { text }),
    replaceSelection: (text) => call('editor.replaceSelection', { text }),
  },
  workspace: {
    root: () => call('workspace.root'),
    readFile: (path) => call('workspace.readFile', { path }),
    writeFile: (path, text) => call('workspace.writeFile', { path, text }),
    findFiles: (query, limit) => call('workspace.findFiles', { query, limit }),
  },
  languages: {
    registerCompletionProvider: (language, provide) => provider('completion', language, provide),
    registerHoverProvider: (language, provide) => provider('hover', language, provide),
  },
  terminal: {
    run: (command, options = {}) => call('terminal.run', { command, ...options }),
  },
  settings: {
    get: (key) => call('settings.get', { key }),
  },
});

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type === 'result') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (typeof message.error === 'string') waiting.reject(new Error(message.error));
    else waiting.resolve(message.result ?? undefined);
    return;
  }
  if (message?.type === 'event') {
    for (const listener of listeners.get(message.event) ?? []) {
      try {
        listener(message.data);
      } catch (err) {
        report(err);
      }
    }
    return;
  }
  if (message?.type === 'invoke') {
    const handler = handlers.get(message.handler);
    try {
      if (!handler) throw new Error(`Nothing handles ${message.handler}.`);
      const result = await handler(...(message.args ?? []));
      postMessage({ type: 'reply', id: message.id, result: result ?? null });
    } catch (err) {
      postMessage({
        type: 'reply',
        id: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
});

self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  report(event.reason);
});

// What the plugin logs goes to its Output channel.
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    postMessage({ type: 'log', level, message: args.map(String).join(' ') });
    original(...args);
  };
}

try {
  const module = await import(PLUGIN.main);
  if (typeof module.activate === 'function') await module.activate(lathe);
  postMessage({ type: 'activated' });
} catch (err) {
  postMessage({
    type: 'activationFailed',
    message: err instanceof Error ? err.message : String(err),
  });
}
