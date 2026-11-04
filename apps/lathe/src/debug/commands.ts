// The debugger's commands and keys, as in VS Code: F5 starts or continues, F9 toggles a
// breakpoint, F10/F11/Shift+F11 step, Shift+F5 stops, Ctrl+Shift+F5 restarts.

import { getActiveView } from '../editor/active';
import { type Command, registerCommands } from '../services/commands';
import type { Keybinding } from '../services/keybindings';
import { notify } from '../services/notifications';
import { showPanel } from '../workbench/layout';
import { quickPick } from '../workbench/quickinput/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { editBreakpointAtCursor, toggleBreakpointAtCursor } from './editor';
import { loadConfigurations, openLaunchJson } from './launch';
import {
  ACTIVE_FILE,
  debugActiveFile,
  evaluateInConsole,
  restartDebugging,
  startDebugging,
  startSelected,
  stopDebugging,
  threadCommand,
} from './manager';
import {
  addWatch,
  clearConsole,
  removeAllBreakpoints,
  setAllBreakpointsEnabled,
  useDebug,
} from './store';

const stopped = "debugState == 'stopped'";
const running = "debugState == 'running'";

/** The selection, or the word at the cursor. */
function selectedExpression(): string | null {
  const view = getActiveView();
  if (!view) return null;
  const { from, to, head } = view.state.selection.main;
  if (from !== to) return view.state.sliceDoc(from, to).trim() || null;
  const word = view.state.wordAt(head);
  return word ? view.state.sliceDoc(word.from, word.to) : null;
}

/** Picks the configuration F5 starts (from launch.json), or the active file. */
export async function selectConfiguration(): Promise<void> {
  const root = useWorkspace.getState().root;
  const configs = root ? await loadConfigurations(root) : [];
  const current = useDebug.getState().selectedConfig;
  const items = [
    ...configs.map((c) => ({
      id: c.config.name,
      label: c.config.name,
      description: `${c.config.type} · ${c.file.includes('.vscode') ? '.vscode' : '.lathe'}/launch.json`,
    })),
    { id: ACTIVE_FILE, label: 'Debug the active file', description: 'No configuration needed' },
    { id: ':configure', label: 'Add a configuration…', description: 'Opens launch.json' },
  ];
  const active = Math.max(
    0,
    items.findIndex((i) => i.id === (current ?? configs[0]?.config.name ?? ACTIVE_FILE)),
  );
  const picked = await quickPick(items, {
    placeholder: 'Debug configuration to start with F5',
    active,
  });
  if (!picked) return;
  if (picked.id === ':configure') {
    await openLaunchJson();
    return;
  }
  useDebug.setState({ selectedConfig: picked.id });
}

export function registerDebugCommands() {
  const commands: Command[] = [
    {
      id: 'debug.start',
      title: 'Start debugging',
      category: 'Debug',
      run: () => void startSelected(),
    },
    {
      id: 'debug.debugFile',
      title: 'Debug this file',
      category: 'Debug',
      run: () => void debugActiveFile(),
    },
    {
      id: 'debug.continue',
      title: 'Continue',
      category: 'Debug',
      when: stopped,
      run: () => void threadCommand('continue'),
    },
    {
      id: 'debug.pause',
      title: 'Pause',
      category: 'Debug',
      when: running,
      run: () => void threadCommand('pause'),
    },
    {
      id: 'debug.stepOver',
      title: 'Step over',
      category: 'Debug',
      when: stopped,
      run: () => void threadCommand('next'),
    },
    {
      id: 'debug.stepInto',
      title: 'Step into',
      category: 'Debug',
      when: stopped,
      run: () => void threadCommand('stepIn'),
    },
    {
      id: 'debug.stepOut',
      title: 'Step out',
      category: 'Debug',
      when: stopped,
      run: () => void threadCommand('stepOut'),
    },
    {
      id: 'debug.stop',
      title: 'Stop debugging',
      category: 'Debug',
      when: 'inDebugMode',
      run: () => void stopDebugging(),
    },
    {
      id: 'debug.restart',
      title: 'Restart debugging',
      category: 'Debug',
      when: 'inDebugMode',
      run: () => void restartDebugging(),
    },
    {
      id: 'debug.toggleBreakpoint',
      title: 'Toggle breakpoint',
      category: 'Debug',
      run: () => toggleBreakpointAtCursor(),
    },
    {
      id: 'debug.addConditionalBreakpoint',
      title: 'Add conditional breakpoint…',
      category: 'Debug',
      run: () => editBreakpointAtCursor('condition'),
    },
    {
      id: 'debug.addLogpoint',
      title: 'Add logpoint…',
      category: 'Debug',
      run: () => editBreakpointAtCursor('logMessage'),
    },
    {
      id: 'debug.removeAllBreakpoints',
      title: 'Remove all breakpoints',
      category: 'Debug',
      run: () => removeAllBreakpoints(),
    },
    {
      id: 'debug.enableAllBreakpoints',
      title: 'Enable all breakpoints',
      category: 'Debug',
      run: () => setAllBreakpointsEnabled(true),
    },
    {
      id: 'debug.disableAllBreakpoints',
      title: 'Disable all breakpoints',
      category: 'Debug',
      run: () => setAllBreakpointsEnabled(false),
    },
    {
      id: 'debug.toggleBreakpointsActive',
      title: 'Turn all breakpoints on or off',
      category: 'Debug',
      run: () => useDebug.setState((s) => ({ breakpointsActive: !s.breakpointsActive })),
    },
    {
      id: 'debug.selectConfiguration',
      title: 'Select debug configuration…',
      category: 'Debug',
      run: () => void selectConfiguration(),
    },
    {
      id: 'debug.configure',
      title: 'Open launch.json',
      category: 'Debug',
      run: () => void openLaunchJson(),
    },
    {
      id: 'debug.addToWatch',
      title: 'Add to watch',
      category: 'Debug',
      run: () => {
        const expression = selectedExpression();
        if (expression) addWatch(expression);
        else notify('info', 'Select an expression to watch first.');
      },
    },
    {
      id: 'debug.evaluateInConsole',
      title: 'Evaluate in debug console',
      category: 'Debug',
      when: 'inDebugMode',
      run: () => {
        const expression = selectedExpression();
        if (!expression) return;
        showPanel('debugConsole');
        void evaluateInConsole(expression);
      },
    },
    {
      id: 'debug.clearConsole',
      title: 'Clear debug console',
      category: 'Debug',
      run: () => clearConsole(),
    },
    {
      id: 'view.debugConsole',
      title: 'Show debug console',
      category: 'View',
      run: () => showPanel('debugConsole', true),
    },
    {
      id: 'debug.startConfiguration',
      title: 'Start a debug configuration',
      hidden: true,
      run: (name: string) =>
        void (async () => {
          const root = useWorkspace.getState().root;
          const found = root
            ? (await loadConfigurations(root)).find((c) => c.config.name === name)
            : undefined;
          if (found) await startDebugging(found.config);
        })(),
    },
  ];
  registerCommands(commands);
}

export const DEBUG_KEYBINDINGS: Keybinding[] = [
  { key: 'f5', command: 'debug.continue', when: stopped },
  { key: 'f5', command: 'debug.start', when: '!inDebugMode' },
  { key: 'f6', command: 'debug.pause', when: running },
  { key: 'f10', command: 'debug.stepOver', when: stopped },
  { key: 'f11', command: 'debug.stepInto', when: stopped },
  { key: 'shift+f11', command: 'debug.stepOut', when: stopped },
  { key: 'shift+f5', command: 'debug.stop', when: 'inDebugMode' },
  { key: 'ctrl+shift+f5', command: 'debug.restart', when: 'inDebugMode' },
  { key: 'f9', command: 'debug.toggleBreakpoint', when: 'editorTextFocus' },
  { key: 'ctrl+shift+y', command: 'view.debugConsole' },
];
