import { Bug, CircleCheck, CircleDashed, Download, Play, RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { type Toolchain, backend, errorMessage } from '../lib/backend';
import { ask } from '../services/dialogs';
import { notify } from '../services/notifications';
import { runInTerminal, useTerminals } from '../workbench/terminal/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { runActiveFile } from './run';
import {
  BreakpointsSection,
  CallStackSection,
  VariablesSection,
  WatchSection,
} from '../debug/DebugViews';
import { type FoundConfig, loadConfigurations, openLaunchJson } from '../debug/launch';
import { ACTIVE_FILE, startSelected } from '../debug/manager';
import { useDebug } from '../debug/store';
import { onDocumentSaved } from '../editor/documents';
import { keyFor } from '../services/keybindings';
import { SOURCE_NAMES, type Task, configureTasks, loadTasks, runTask } from './tasks';

let cached: Toolchain[] | null = null;

const iconButton =
  'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text';
const heading = 'flex-1 text-[11px] font-medium tracking-wide text-text-3 uppercase';

/** Run and debug: debug or run the active file (or a launch.json configuration), the debugger's
 * sections, tasks, and which toolchains are installed. */
export function RunView() {
  const root = useWorkspace((s) => s.root);
  const selected = useDebug((s) => s.selectedConfig);
  const active = useDebug((s) => s.sessions.length > 0);
  const [configs, setConfigs] = useState<FoundConfig[]>([]);
  const load = useCallback(async () => {
    setConfigs(root ? await loadConfigurations(root).catch(() => []) : []);
  }, [root]);
  useEffect(() => {
    void load();
  }, [load]);
  // launch.json saved in Lathe: pick up its configurations.
  useEffect(
    () =>
      onDocumentSaved((doc) => {
        if (doc.path && /[\\/]launch\.json$/i.test(doc.path)) void load();
      }),
    [load],
  );
  const value =
    selected && (selected === ACTIVE_FILE || configs.some((c) => c.config.name === selected))
      ? selected
      : (configs[0]?.config.name ?? ACTIVE_FILE);
  const startKey = keyFor('debug.start') ?? 'F5';
  return (
    <div className="flex h-full min-h-0 flex-col" data-view="debug">
      <header className="flex h-(--tabs-h) shrink-0 items-center gap-1 pr-1.5 pl-3">
        <h2 className="flex-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
          Run and debug
        </h2>
        <button
          type="button"
          aria-label="Open launch.json"
          title="Open launch.json (debug configurations)"
          className={iconButton}
          onClick={() => void openLaunchJson().then(load)}
        >
          <Settings2 className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="space-y-1.5 px-3">
          {configs.length > 0 && (
            <select
              aria-label="Debug configuration"
              value={value}
              onChange={(e) => useDebug.setState({ selectedConfig: e.target.value })}
              className="h-7 w-full rounded-md border border-line bg-raised px-2 text-[12px] text-text outline-none focus:border-accent-fg"
            >
              {configs.map((c) => (
                <option key={c.config.name} value={c.config.name}>
                  {c.config.name}
                </option>
              ))}
              <option value={ACTIVE_FILE}>Debug the active file</option>
            </select>
          )}
          <button
            type="button"
            data-autofocus
            onClick={() => void startSelected()}
            className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-accent text-[12px] font-medium text-accent-ink hover:brightness-95"
          >
            <Bug className="size-3.5" />
            {value === ACTIVE_FILE ? 'Debug this file' : 'Start debugging'}
            <span className="font-normal opacity-70">{startKey}</span>
          </button>
          <button
            type="button"
            onClick={() => void runActiveFile()}
            className="flex h-7 w-full items-center justify-center gap-2 rounded-md border border-line text-[12px] text-text hover:bg-hover"
          >
            <Play className="size-3.5" />
            Run file
            <span className="text-text-3">{keyFor('run.file') ?? 'Ctrl+F5'}</span>
          </button>
          {!active && (
            <p className="pt-0.5 text-[11.5px] text-text-3">
              Click left of a line number to set a breakpoint, then debug. Run file runs without the
              debugger, in a terminal that reads your input.
            </p>
          )}
        </div>
        {active && <VariablesSection />}
        <WatchSection />
        {active && <CallStackSection />}
        <BreakpointsSection />
        <TaskList />
        <ToolchainList />
      </div>
    </div>
  );
}

function TaskList() {
  const root = useWorkspace((s) => s.root);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const load = useCallback(async () => {
    setTasks(root ? await loadTasks(root).catch(() => []) : null);
  }, [root]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!root) return null;
  const shown = tasks?.filter((t) => !t.hidden) ?? [];
  return (
    <section aria-label="Tasks">
      <div className="mt-4 flex items-center px-3">
        <h3 className={heading}>Tasks</h3>
        <button
          type="button"
          aria-label="Configure tasks"
          title="Configure tasks (.lathe/tasks.json)"
          className={iconButton}
          onClick={() => void configureTasks()}
        >
          <Settings2 className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Reload tasks"
          title="Reload tasks"
          className={iconButton}
          onClick={() => void load()}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <ul className="px-1.5">
        {tasks && !shown.length && (
          <li className="px-1.5 py-1 text-[11.5px] text-text-3">
            No tasks yet. Add them to .lathe/tasks.json; package.json scripts and Cargo commands
            show up on their own.
          </li>
        )}
        {shown.map((task) => (
          <li key={task.label}>
            <button
              type="button"
              className="group flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-hover"
              title={`${task.detail ?? [task.command, ...task.args].join(' ')}\n${SOURCE_NAMES[task.source]}`}
              onClick={() => void runTask(task)}
            >
              <Play className="size-3 shrink-0 text-text-3 group-hover:text-accent-fg" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-text">{task.label}</span>
              {task.group && (
                <span className="shrink-0 text-[10.5px] text-text-3">
                  {task.group}
                  {task.isDefault ? ' · default' : ''}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ToolchainList() {
  const [toolchains, setToolchains] = useState<Toolchain[] | null>(cached);
  const [busy, setBusy] = useState(false);
  const installing = useTerminals((s) => s.terminals.find((t) => t.tag === 'install'));

  const detect = async () => {
    setBusy(true);
    try {
      await backend().toolchains.refreshPath();
      cached = await backend().toolchains.detect();
      setToolchains(cached);
    } catch (err) {
      notify('error', "Couldn't check the toolchains.", { detail: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!cached) void detect();
  }, []);

  // When an install finishes, look again.
  useEffect(() => {
    if (installing && !installing.running) void detect();
  }, [installing?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (toolchain: Toolchain) => {
    if (!toolchain.winget) return;
    const args = await backend().toolchains.wingetArgs(toolchain.winget);
    const answer = await ask({
      title: `Install ${toolchain.name}?`,
      message: `Lathe will run this in a terminal, and Windows may ask for permission:\nwinget ${args.join(' ')}`,
      buttons: [
        { id: 'install', label: 'Install', primary: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'install') return;
    await runInTerminal({
      title: `Install ${toolchain.name}`,
      program: 'winget',
      args,
      cwd: backend().boot().dataDir,
      env: [],
      tag: 'install',
    });
  };

  return (
    <section aria-label="Toolchains">
      <div className="mt-4 flex items-center px-3">
        <h3 className={heading}>Toolchains</h3>
        <button
          type="button"
          aria-label="Check again"
          title="Check again"
          className={iconButton}
          onClick={() => void detect()}
        >
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <ul className="px-1.5">
        {!toolchains && <li className="px-1.5 py-1 text-[12px] text-text-3">Checking…</li>}
        {toolchains?.map((t) => {
          const found = !!(t.path || t.version);
          return (
            <li
              key={t.id}
              className="group flex items-start gap-2 rounded-sm px-1.5 py-1 hover:bg-hover"
              title={t.path ?? undefined}
            >
              {found ? (
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-accent-fg" />
              ) : (
                <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-text-4" />
              )}
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[12px] ${found ? 'text-text' : 'text-text-3'}`}>
                  {t.name}
                </div>
                <div className="truncate text-[11px] text-text-3">
                  {found ? (t.version ?? 'Installed') : t.languages}
                </div>
              </div>
              {!found && t.winget && (
                <button
                  type="button"
                  aria-label={`Install ${t.name}`}
                  title={`Install ${t.name} with winget`}
                  className="mt-0.5 grid size-6 place-items-center rounded-sm text-text-3 opacity-0 group-hover:opacity-100 hover:bg-active hover:text-text focus-visible:opacity-100"
                  onClick={() => void install(t)}
                >
                  <Download className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
