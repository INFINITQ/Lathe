// Run and debug's sections: Variables and Call stack while a session runs, Watch and Breakpoints
// always. Values load lazily as you expand them; what you expanded stays expanded from one stop
// to the next, as in VS Code.

import { ChevronDown, ChevronRight, CircleSlash2, ListX, Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../lib/backend';
import { cn } from '../lib/cn';
import { basename, dirname, relative } from '../lib/paths';
import { openPath } from '../workbench/editors/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { breakpointKind, describeBreakpoint } from './editor';
import {
  type Scope,
  type Variable,
  evaluate,
  exceptionFiltersOf,
  knownAdapters,
  scopesOf,
  selectFrame,
  setExceptionFilter,
  setVariableValue,
  variablesOf,
} from './manager';
import {
  type Breakpoint,
  type SessionInfo,
  type Watch,
  addWatch,
  editWatch,
  removeAllBreakpoints,
  removeAllWatches,
  removeBreakpoint,
  removeWatch,
  updateBreakpoint,
  useDebug,
} from './store';

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';
const rowClass =
  'group flex h-[22px] min-w-0 cursor-default items-center gap-1 pr-2 text-[12px] hover:bg-hover';

const openSections = new Map<string, boolean>();

function Section({
  id,
  title,
  actions,
  children,
}: {
  id: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(openSections.get(id) ?? true);
  return (
    <section aria-label={title} className="mt-3">
      <div className="group/section flex h-7 items-center pr-1.5 pl-1.5">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => {
            openSections.set(id, !open);
            setOpen(!open);
          }}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-text-3" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-text-3" />
          )}
          <h3 className="truncate text-[11px] font-medium tracking-wide text-text-3 uppercase">
            {title}
          </h3>
        </button>
        {actions && (
          <div className="flex opacity-0 group-hover/section:opacity-100 focus-within:opacity-100">
            {actions}
          </div>
        )}
      </div>
      {open && children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-1 text-[11.5px] text-text-3">{children}</p>;
}

/** What you expanded, by path ("Locals/config"), kept across stops. */
const expanded = new Set<string>();
/** Scopes you collapsed (the first scope starts open). */
const collapsedScopes = new Set<string>();

function ValueInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      aria-label={label}
      defaultValue={initial}
      className="h-[19px] min-w-0 flex-1 rounded-sm border border-accent-fg bg-bg px-1 font-mono text-[12px] text-text outline-none"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(null);
        e.stopPropagation();
      }}
      onBlur={(e) => finish(e.currentTarget.value === initial ? null : e.currentTarget.value)}
    />
  );
}

/** One variable (or scope, or watch result), expanding into its children. */
export function VariableNode({
  sessionId,
  node,
  depth,
  path,
  parentRef,
  scope,
  editable,
  label,
  actions,
  onEdit,
}: {
  sessionId: string;
  node: Pick<Variable, 'name' | 'value' | 'type' | 'variablesReference'>;
  depth: number;
  path: string;
  /** The container it belongs to, for changing its value. */
  parentRef: number;
  scope?: { first: boolean };
  editable?: boolean;
  /** Overrides the accessible name. */
  label?: string;
  actions?: ReactNode;
  /** Double-click edits something other than the value (a watch's expression). */
  onEdit?: () => void;
}) {
  const epoch = useDebug((s) => s.epoch);
  const [open, setOpen] = useState(() =>
    scope ? scope.first && !collapsedScopes.has(path) : expanded.has(path),
  );
  const [children, setChildren] = useState<Variable[] | null>(null);
  const [editing, setEditing] = useState(false);
  const expandable = node.variablesReference > 0;

  useEffect(() => {
    if (!open || !expandable) {
      setChildren(null);
      return;
    }
    let cancelled = false;
    variablesOf(sessionId, node.variablesReference).then(
      (list) => !cancelled && setChildren(list),
      () => !cancelled && setChildren([]),
    );
    return () => {
      cancelled = true;
    };
  }, [open, expandable, sessionId, node.variablesReference, epoch]);

  const toggle = () => {
    if (!expandable) return;
    const next = !open;
    if (scope) {
      if (next) collapsedScopes.delete(path);
      else collapsedScopes.add(path);
    } else if (next) expanded.add(path);
    else expanded.delete(path);
    setOpen(next);
  };

  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      aria-label={label ?? (scope ? node.name : `${node.name} = ${node.value}`)}
      aria-selected={false}
    >
      <div
        className={rowClass}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.type ? `${node.name}: ${node.type}` : undefined}
        onClick={toggle}
        onDoubleClick={() => {
          if (onEdit) onEdit();
          else if (editable && !scope) setEditing(true);
        }}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-text-3">
          {expandable &&
            (open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />)}
        </span>
        {scope ? (
          <span className="truncate text-[11.5px] text-text-2">{node.name}</span>
        ) : (
          <>
            <span className="shrink-0 font-mono text-text-2">{node.name}</span>
            {editing ? (
              <ValueInput
                initial={node.value}
                label={`New value of ${node.name}`}
                onDone={(value) => {
                  setEditing(false);
                  if (value !== null) void setVariableValue(sessionId, parentRef, node.name, value);
                }}
              />
            ) : (
              <>
                {node.value !== '' && <span className="shrink-0 text-text-4">=</span>}
                <span className="min-w-0 flex-1 truncate font-mono text-text">{node.value}</span>
              </>
            )}
          </>
        )}
        {actions}
      </div>
      {open && children && (
        <div role="group">
          {children.slice(0, 500).map((child, i) => (
            <VariableNode
              key={`${child.name}:${i}`}
              sessionId={sessionId}
              node={child}
              depth={depth + 1}
              path={`${path}/${child.name}`}
              parentRef={node.variablesReference}
              editable={editable}
            />
          ))}
          {children.length > 500 && (
            <p
              className="py-0.5 text-[11.5px] text-text-3"
              style={{ paddingLeft: 26 + depth * 12 }}
            >
              …and {children.length - 500} more
            </p>
          )}
          {!children.length && (
            <p
              className="py-0.5 text-[11.5px] text-text-3"
              style={{ paddingLeft: 26 + depth * 12 }}
            >
              Nothing here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function VariablesSection() {
  const focus = useDebug((s) => s.focus);
  const epoch = useDebug((s) => s.epoch);
  const session = useDebug((s) => s.sessions.find((x) => x.id === s.focus?.sessionId));
  const [scopes, setScopes] = useState<Scope[] | null>(null);
  const frameId = focus?.frameId ?? null;
  const sessionId = focus?.sessionId ?? null;

  useEffect(() => {
    setScopes(null);
    if (!sessionId || frameId === null) return;
    let cancelled = false;
    scopesOf(sessionId, frameId).then(
      (list) => !cancelled && setScopes(list),
      () => !cancelled && setScopes([]),
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, frameId, epoch]);

  return (
    <Section id="variables" title="Variables">
      {!sessionId || frameId === null || session?.status !== 'stopped' ? (
        <Empty>Values show here while the program is paused.</Empty>
      ) : !scopes ? (
        <Empty>Loading…</Empty>
      ) : (
        <div role="tree" aria-label="Variables">
          {scopes.map((scope, i) => (
            <VariableNode
              key={scope.name}
              sessionId={sessionId}
              node={{ name: scope.name, value: '', variablesReference: scope.variablesReference }}
              depth={0}
              path={scope.name}
              parentRef={0}
              scope={{ first: i === 0 && !scope.expensive }}
              editable={session?.supports.setVariable}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

function WatchRow({ watch }: { watch: Watch }) {
  const epoch = useDebug((s) => s.epoch);
  const focusKey = useDebug((s) => `${s.focus?.sessionId}:${s.focus?.frameId}`);
  const running = useDebug((s) => s.sessions.length > 0);
  const [result, setResult] = useState<{
    value: string;
    ref: number;
    sessionId: string;
    type?: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!running) {
      setResult(null);
      return;
    }
    let cancelled = false;
    evaluate(watch.expression, 'watch').then(
      (r) =>
        !cancelled &&
        setResult({
          value: r.result,
          ref: r.variablesReference,
          sessionId: r.sessionId,
          type: r.type,
        }),
      (err: unknown) =>
        !cancelled && setResult({ value: errorMessage(err), ref: 0, sessionId: '' }),
    );
    return () => {
      cancelled = true;
    };
  }, [watch.expression, epoch, focusKey, running]);

  if (editing) {
    return (
      <div className={rowClass} style={{ paddingLeft: 22 }}>
        <ValueInput
          initial={watch.expression}
          label="Watch expression"
          onDone={(value) => {
            setEditing(false);
            if (value !== null) editWatch(watch.id, value);
          }}
        />
      </div>
    );
  }
  const value = result?.value ?? (running ? '…' : 'not available');
  return (
    <VariableNode
      key={`${result?.sessionId}:${result?.ref}`}
      sessionId={result?.sessionId ?? ''}
      node={{
        name: watch.expression,
        value,
        type: result?.type,
        variablesReference: result?.ref ?? 0,
      }}
      depth={0}
      path={`watch:${watch.id}`}
      parentRef={0}
      label={`${watch.expression} = ${value}`}
      onEdit={() => setEditing(true)}
      actions={
        <button
          type="button"
          aria-label={`Remove ${watch.expression}`}
          title="Remove expression"
          className={cn(iconButton, 'size-5 opacity-0 group-hover:opacity-100')}
          onClick={(e) => {
            e.stopPropagation();
            removeWatch(watch.id);
          }}
        >
          <X />
        </button>
      }
    />
  );
}

export function WatchSection() {
  const watches = useDebug((s) => s.watches);
  const [adding, setAdding] = useState(false);
  return (
    <Section
      id="watch"
      title="Watch"
      actions={
        <>
          <button
            type="button"
            aria-label="Add expression"
            title="Add expression"
            className={iconButton}
            onClick={() => setAdding(true)}
          >
            <Plus />
          </button>
          <button
            type="button"
            aria-label="Remove all expressions"
            title="Remove all expressions"
            className={iconButton}
            onClick={removeAllWatches}
          >
            <ListX />
          </button>
        </>
      }
    >
      <div role="tree" aria-label="Watch">
        {watches.map((watch) => (
          <WatchRow key={watch.id} watch={watch} />
        ))}
        {adding && (
          <div className={rowClass} style={{ paddingLeft: 22 }}>
            <ValueInput
              initial=""
              label="Expression to watch"
              onDone={(value) => {
                setAdding(false);
                if (value) addWatch(value);
              }}
            />
          </div>
        )}
      </div>
      {!watches.length && !adding && (
        <Empty>Add expressions to see their values as you step.</Empty>
      )}
    </Section>
  );
}

function statusLabel(session: SessionInfo): string {
  if (session.status === 'starting') return 'Starting';
  if (session.status !== 'stopped') return 'Running';
  const stopped = session.threads.find((t) => t.stopped)?.stopped;
  if (!stopped) return 'Paused';
  const reason = stopped.description ?? `Paused on ${stopped.reason}`;
  return reason.length > 40 ? `${reason.slice(0, 40)}…` : reason;
}

function SessionNode({ session, depth }: { session: SessionInfo; depth: number }) {
  const sessions = useDebug((s) => s.sessions);
  const focus = useDebug((s) => s.focus);
  const children = sessions.filter((s) => s.parentId === session.id);
  const singleThread = session.threads.length === 1;
  return (
    <div role="treeitem" aria-label={`${session.name}: ${statusLabel(session)}`} aria-expanded>
      <div className={rowClass} style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="min-w-0 flex-1 truncate text-text">{session.name}</span>
        <span className="shrink-0 text-[11px] text-text-3">{statusLabel(session)}</span>
      </div>
      <div role="group">
        {children.map((child) => (
          <SessionNode key={child.id} session={child} depth={depth + 1} />
        ))}
        {session.threads.map((thread) => (
          <div key={thread.id}>
            {!singleThread && (
              <div className={rowClass} style={{ paddingLeft: 20 + depth * 12 }}>
                <span className="min-w-0 flex-1 truncate text-text-2">{thread.name}</span>
                <span className="shrink-0 text-[11px] text-text-3">
                  {thread.stopped ? 'Paused' : 'Running'}
                </span>
              </div>
            )}
            {thread.frames.map((frame) => {
              const selected = focus?.sessionId === session.id && focus.frameId === frame.id;
              const file = frame.sourceName ?? (frame.path ? basename(frame.path) : null);
              return (
                <button
                  key={frame.id}
                  type="button"
                  role="treeitem"
                  aria-selected={selected}
                  aria-label={`${frame.name}${file ? ` at ${file}:${frame.line}` : ''}`}
                  disabled={frame.hint === 'label'}
                  className={cn(
                    rowClass,
                    'w-full text-left',
                    selected && 'bg-active',
                    frame.hint !== 'normal' && 'text-text-3',
                  )}
                  style={{ paddingLeft: (singleThread ? 22 : 34) + depth * 12 }}
                  onClick={() => selectFrame(session.id, thread.id, frame)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{frame.name}</span>
                  {file && (
                    <span className="shrink-0 text-[11px] text-text-3">
                      {file}:{frame.line}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CallStackSection() {
  const sessions = useDebug((s) => s.sessions);
  const roots = sessions.filter((s) => !s.parentId || !sessions.some((p) => p.id === s.parentId));
  return (
    <Section id="callstack" title="Call stack">
      <div role="tree" aria-label="Call stack">
        {roots.map((session) => (
          <SessionNode key={session.id} session={session} depth={0} />
        ))}
      </div>
    </Section>
  );
}

function BreakpointDot({ bp, active }: { bp: Breakpoint; active: boolean }) {
  const kind = breakpointKind(bp, active);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full',
        kind === 'disabled' && 'border-[1.5px] border-text-4',
        kind === 'unverified' && 'border-[1.5px] border-text-3',
        kind === 'log' && 'rotate-45 rounded-[1px] bg-danger',
        (kind === 'normal' || kind === 'conditional') && 'bg-danger',
      )}
    />
  );
}

export function BreakpointsSection() {
  const breakpoints = useDebug((s) => s.breakpoints);
  const active = useDebug((s) => s.breakpointsActive);
  const chosen = useDebug((s) => s.exceptionFilters);
  // Adapters seen this run, so their exception filters show even between sessions.
  useDebug((s) => s.sessions.length);
  const root = useWorkspace((s) => s.root);
  const sorted = [...breakpoints].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const adapters = knownAdapters();
  return (
    <Section
      id="breakpoints"
      title="Breakpoints"
      actions={
        <>
          <button
            type="button"
            aria-label={active ? 'Turn breakpoints off' : 'Turn breakpoints on'}
            title={active ? 'Turn breakpoints off (keeps them)' : 'Turn breakpoints on'}
            aria-pressed={!active}
            className={cn(iconButton, !active && 'text-accent-fg')}
            onClick={() => useDebug.setState({ breakpointsActive: !active })}
          >
            <CircleSlash2 />
          </button>
          <button
            type="button"
            aria-label="Remove all breakpoints"
            title="Remove all breakpoints"
            className={iconButton}
            onClick={removeAllBreakpoints}
          >
            <ListX />
          </button>
        </>
      }
    >
      <ul aria-label="Breakpoint list">
        {adapters.flatMap((adapter) =>
          exceptionFiltersOf(adapter).map((filter) => {
            const on = (
              chosen[adapter] ??
              exceptionFiltersOf(adapter)
                .filter((f) => f.default)
                .map((f) => f.filter)
            ).includes(filter.filter);
            return (
              <li
                key={`${adapter}:${filter.filter}`}
                className={rowClass}
                style={{ paddingLeft: 10 }}
              >
                <label
                  className="flex min-w-0 flex-1 items-center gap-2"
                  title={filter.description}
                >
                  <input
                    type="checkbox"
                    className="size-3 shrink-0 accent-(--accent-fg)"
                    checked={on}
                    onChange={(e) => setExceptionFilter(adapter, filter.filter, e.target.checked)}
                  />
                  <span className="truncate text-text-2">{filter.label}</span>
                  {adapters.length > 1 && (
                    <span className="shrink-0 text-[11px] text-text-3">{adapter}</span>
                  )}
                </label>
              </li>
            );
          }),
        )}
        {sorted.map((bp) => {
          const where = root ? relative(root, dirname(bp.path)) : dirname(bp.path);
          const detail = bp.logMessage
            ? `log ${bp.logMessage}`
            : [bp.condition && `when ${bp.condition}`, bp.hitCondition && `hit ${bp.hitCondition}`]
                .filter(Boolean)
                .join(', ');
          return (
            <li
              key={bp.id}
              className={cn(rowClass, 'h-auto min-h-[22px]')}
              style={{ paddingLeft: 10 }}
              title={describeBreakpoint(bp, active)}
            >
              <input
                type="checkbox"
                aria-label={`Breakpoint at ${basename(bp.path)}:${bp.line}`}
                className="size-3 shrink-0 accent-(--accent-fg)"
                checked={bp.enabled}
                onChange={(e) => updateBreakpoint(bp.id, { enabled: e.target.checked })}
              />
              <BreakpointDot bp={bp} active={active} />
              <button
                type="button"
                className="flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 text-left"
                onClick={() => void openPath(bp.path, { selection: { line: bp.line } })}
              >
                <span className="shrink-0 text-text">{basename(bp.path)}</span>
                {detail ? (
                  <span className="min-w-0 truncate font-mono text-[11px] text-text-3">
                    {detail}
                  </span>
                ) : (
                  where &&
                  where !== '.' && (
                    <span className="min-w-0 truncate text-[11px] text-text-3">{where}</span>
                  )
                )}
              </button>
              <span className="shrink-0 font-mono text-[11px] text-text-3">{bp.line}</span>
              <button
                type="button"
                aria-label={`Remove breakpoint at ${basename(bp.path)}:${bp.line}`}
                title="Remove breakpoint"
                className={cn(iconButton, 'size-5 opacity-0 group-hover:opacity-100')}
                onClick={() => removeBreakpoint(bp.id)}
              >
                <X />
              </button>
            </li>
          );
        })}
      </ul>
      {!breakpoints.length && (
        <Empty>Click left of a line number, or press F9, to pause the program there.</Empty>
      )}
    </Section>
  );
}
