// The Keyboard shortcuts editor: every command with its keys, where each key comes from, and
// which keys clash. Change a key by pressing it (two-key chords too), change when it applies,
// remove it, or reset a command to Lathe's own. Changes go into keybindings.json.

import { FileJson, Keyboard, Pencil, RotateCcw, TriangleAlert, X } from 'lucide-react';
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { cn } from '../../lib/cn';
import {
  allCommands,
  commandLabel,
  executeCommand,
  onCommandsChanged,
} from '../../services/commands';
import {
  type KeybindingSource,
  displayKey,
  keyOf,
  keybindingsBySource,
  normalizeKey,
  onKeybindingsChanged,
  suspendKeybindings,
  userKeybindingEntries,
} from '../../services/keybindings';
import {
  type KeybindingRow,
  changeKeybinding,
  changeWhen,
  removeKeybinding,
  resetKeybindings,
} from '../../services/userKeybindings';
import { showMenuAt, type MenuEntry } from '../../ui/Menu';
import { quickInputText } from '../quickinput/store';

interface Row extends KeybindingRow {
  id: string;
  label: string;
  /** The command exists (a plugin that's off, or a typo in keybindings.json, leaves it unknown). */
  known: boolean;
  /** You have entries for this command, so Reset has something to undo. */
  changed: boolean;
  /** Other commands bound to the same key where both could apply. */
  clashes: string[];
}

const SOURCE_LABEL: Record<KeybindingSource, string> = {
  user: 'Yours',
  plugin: 'Plugin',
  default: 'Lathe',
};

/** Keys CodeMirror handles inside the editor itself (not commands, so not changeable here). */
const EDITING_KEYS: [string, string][] = [
  ['Ctrl+D', 'Add the next match to the selection'],
  ['Ctrl+Shift+L', 'Select every match'],
  ['Alt+Up, Alt+Down', 'Move the line up or down'],
  ['Shift+Alt+Up, Shift+Alt+Down', 'Copy the line up or down'],
  ['Ctrl+Shift+K', 'Delete the line'],
  ['Ctrl+/', 'Comment or uncomment the line'],
  ['Shift+Alt+A', 'Comment or uncomment the selection'],
  ['Ctrl+Alt+Up, Ctrl+Alt+Down', 'Add a cursor above or below'],
  ['Alt+Click', 'Add a cursor'],
  ['Shift+Alt+Drag', 'Select a column'],
  ['Ctrl+Enter, Ctrl+Shift+Enter', 'Start a new line below or above'],
  ['Ctrl+], Ctrl+[', 'Indent or outdent'],
  ['Ctrl+Space', 'Show suggestions'],
  ['Ctrl+F, Ctrl+H', 'Find, or find and replace'],
  ['Ctrl+Z, Ctrl+Y', 'Undo, redo'],
];

let version = 0;
const bump = () => version++;
onKeybindingsChanged(bump);
onCommandsChanged(bump);

/** Re-renders when keybindings or the command list change. */
function useKeybindingsVersion(): number {
  return useSyncExternalStore(
    (notify) => {
      const stops = [onKeybindingsChanged(notify), onCommandsChanged(notify)];
      return () => stops.forEach((stop) => stop());
    },
    () => version,
  );
}

/** Two `when` clauses that could both hold (no clause always holds). */
const overlap = (a?: string, b?: string) => !a || !b || a === b;

function buildRows(): Row[] {
  const commands = new Map(allCommands().map((c) => [c.id, c]));
  const yours = new Set(userKeybindingEntries().map((b) => b.command.replace(/^-/, '')));
  const bindings = keybindingsBySource();
  const bound = new Set(bindings.map((b) => b.command));
  const rows: Row[] = bindings.map((b, i) => {
    const command = commands.get(b.command);
    return {
      id: `${b.source}:${i}`,
      command: b.command,
      key: b.key,
      when: b.when,
      source: b.source,
      label: command ? commandLabel(command) : b.command,
      known: !!command,
      changed: yours.has(b.command),
      clashes: [],
    };
  });
  for (const row of rows) {
    row.clashes = rows
      .filter((o) => o !== row && o.key === row.key && overlap(o.when, row.when))
      .map((o) => o.label);
  }
  const unbound: Row[] = [...commands.values()]
    .filter((c) => !c.hidden && !bound.has(c.id))
    .map((c) => ({
      id: `none:${c.id}`,
      command: c.id,
      label: commandLabel(c),
      known: true,
      changed: yours.has(c.id),
      clashes: [],
    }));
  const byLabel = (a: Row, b: Row) => a.label.localeCompare(b.label);
  return [...rows.sort(byLabel), ...unbound.sort(byLabel)];
}

/** A search: words to find anywhere, or a key in quotes ("ctrl+k ctrl+s") to match exactly. */
function matches(row: Row, query: string): boolean {
  const quoted = /^"(.+)"$/.exec(query.trim());
  if (quoted) {
    const key = normalizeKey(quoted[1]!);
    return !!row.key && (row.key === key || row.key.startsWith(`${key} `));
  }
  const haystack = [
    row.label,
    row.command,
    row.key ?? '',
    row.key ? displayKey(row.key) : '',
    row.when ?? '',
    row.source ? SOURCE_LABEL[row.source] : '',
  ]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** "Ctrl+K Ctrl+S" as key caps. */
export function KeyCaps({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {displayKey(value)
        .split(' ')
        .map((stroke, i) => (
          // The space keeps the strokes apart for screen readers (flex hides it on screen).
          <Fragment key={i}>
            {i > 0 && ' '}
            <kbd className="rounded-sm border border-line bg-raised px-1.5 py-px font-sans text-[11px] whitespace-nowrap text-text-2">
              {stroke}
            </kbd>
          </Fragment>
        ))}
    </span>
  );
}

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';

export function KeybindingsEditor() {
  const keysVersion = useKeybindingsVersion();
  // The rows are rebuilt whenever keybindings or commands change (keysVersion counts that).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => buildRows(), [keysVersion]);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(false);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<Row | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLTableSectionElement>(null);
  const shown = useMemo(() => rows.filter((r) => matches(r, query)), [rows, query]);
  const current = shown[Math.min(selected, shown.length - 1)];

  useLayoutEffect(() => {
    search.current?.focus();
  }, []);

  // While searching by keys, the keys you press go into the search instead of running commands.
  useEffect(() => {
    if (!recording) return;
    suspendKeybindings(true);
    return () => suspendKeybindings(false);
  }, [recording]);

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(index, shown.length - 1));
    setSelected(next);
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`);
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    });
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (recording) {
      event.preventDefault();
      const stroke = keyOf(event.nativeEvent);
      if (!stroke) return;
      const previous = /^"(.+)"$/.exec(query)?.[1]?.split(' ') ?? [];
      const strokes = previous.length === 1 ? [...previous, stroke] : [stroke];
      setQuery(`"${strokes.join(' ')}"`);
      setSelected(0);
      return;
    }
    if (event.key === 'ArrowDown' && shown.length) {
      event.preventDefault();
      focusRow(selected);
    }
  };

  const onRowKey = (event: ReactKeyboardEvent, index: number, row: Row) => {
    if (event.key === 'ArrowDown') focusRow(index + 1);
    else if (event.key === 'ArrowUp') {
      if (index === 0) search.current?.focus();
      else focusRow(index - 1);
    } else if (event.key === 'Home') focusRow(0);
    else if (event.key === 'End') focusRow(shown.length - 1);
    else if (event.key === 'PageDown') focusRow(index + 15);
    else if (event.key === 'PageUp') focusRow(index - 15);
    else if (event.key === 'Enter') setEditing(row);
    else if (event.key === 'Delete' && row.key) void removeKeybinding(row);
    else return;
    event.preventDefault();
  };

  const menu = (row: Row): MenuEntry[] => [
    { label: 'Change keybinding…', shortcut: 'Enter', run: () => setEditing(row) },
    ...(row.key
      ? ([
          {
            label: 'Change when…',
            run: async () => {
              const when = await quickInputText({
                placeholder: 'When (empty for always)',
                value: row.when ?? '',
                prompt: 'A when clause, such as editorTextFocus && !inDebugMode. Enter saves it.',
              });
              if (when !== null) await changeWhen(row, when);
            },
          },
          { label: 'Remove keybinding', shortcut: 'Delete', run: () => removeKeybinding(row) },
        ] as MenuEntry[])
      : []),
    ...(row.changed
      ? ([{ label: "Reset to Lathe's", run: () => resetKeybindings(row.command) }] as MenuEntry[])
      : []),
    'separator',
    ...(row.key
      ? ([
          {
            label: 'Show commands with this key',
            run: () => {
              setRecording(false);
              setQuery(`"${row.key}"`);
              setSelected(0);
            },
          },
        ] as MenuEntry[])
      : []),
    { label: 'Copy command id', run: () => void navigator.clipboard.writeText(row.command) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" data-editor="keybindings">
      <header className="shrink-0 px-6 pt-5 pb-3">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-[15px] font-medium text-text">Keyboard shortcuts</h1>
          <span className="text-[11.5px] text-text-3" aria-live="polite">
            {shown.length === rows.length ? `${rows.length} commands` : `${shown.length} found`}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-[12px] text-text-3 hover:bg-hover hover:text-text"
            onClick={() => void executeCommand('preferences.openKeybindingsJson')}
          >
            <FileJson className="size-3.5" />
            keybindings.json
          </button>
        </div>
        <div className="flex h-8 items-center gap-1 rounded-md border border-line bg-raised pr-1 pl-2.5 focus-within:border-line-strong">
          <input
            ref={search}
            type="search"
            aria-label="Search keyboard shortcuts"
            placeholder={
              recording
                ? 'Press the keys to look for…'
                : 'Search by command, key or when clause; "ctrl+s" in quotes for an exact key'
            }
            spellCheck={false}
            value={query}
            readOnly={recording}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onSearchKey}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-4"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className={iconButton}
              onClick={() => {
                setQuery('');
                search.current?.focus();
              }}
            >
              <X />
            </button>
          )}
          <button
            type="button"
            aria-pressed={recording}
            aria-label="Search by pressing keys"
            title="Search by pressing keys"
            className={cn(iconButton, recording && 'bg-accent-soft text-accent-fg')}
            onClick={() => {
              setRecording((r) => !r);
              search.current?.focus();
            }}
          >
            <Keyboard />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <table className="w-full table-fixed border-collapse text-[12.5px]">
          <caption className="sr-only">Commands and their keyboard shortcuts</caption>
          <colgroup>
            <col />
            <col className="w-[26%]" />
            <col className="w-[22%]" />
            <col className="w-[70px]" />
            <col className="w-[84px]" />
          </colgroup>
          <thead className="sticky top-0 z-[1] bg-bg">
            <tr className="h-7 border-b border-line text-left text-[11px] font-medium tracking-wide text-text-3 uppercase">
              <th className="pl-2 font-medium">Command</th>
              <th className="font-medium">Keys</th>
              <th className="font-medium">When</th>
              <th className="font-medium">From</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody ref={list}>
            {shown.map((row, i) => {
              const isCurrent = row === current;
              return (
                <tr
                  key={row.id}
                  data-row-index={i}
                  data-command={row.command}
                  tabIndex={isCurrent ? 0 : -1}
                  data-current={isCurrent || undefined}
                  className={cn(
                    'group h-8 border-b border-line outline-none last:border-b-0',
                    isCurrent ? 'bg-hover' : 'hover:bg-hover/60',
                    'focus-visible:shadow-[inset_2px_0_0_var(--accent-fg)]',
                  )}
                  onClick={() => setSelected(i)}
                  onDoubleClick={() => setEditing(row)}
                  onKeyDown={(e) => onRowKey(e, i, row)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSelected(i);
                    showMenuAt(e.clientX, e.clientY, menu(row));
                  }}
                >
                  <td className="truncate pl-2" title={row.command}>
                    <span className={row.known ? 'text-text' : 'text-text-3'}>{row.label}</span>
                    {!row.known && (
                      <span className="ml-2 text-[11px] text-text-3">(no such command now)</span>
                    )}
                  </td>
                  <td>
                    <span className="flex items-center gap-1.5">
                      {row.key ? (
                        <KeyCaps value={row.key} />
                      ) : (
                        <span className="text-text-4">—</span>
                      )}
                      {row.clashes.length > 0 && (
                        <TriangleAlert
                          role="img"
                          className="size-3.5 shrink-0 text-warning"
                          aria-label={`Also bound to ${row.clashes.join(', ')}`}
                        >
                          <title>{`Also bound to ${row.clashes.join(', ')}`}</title>
                        </TriangleAlert>
                      )}
                    </span>
                  </td>
                  <td
                    className="truncate font-mono text-[11.5px] text-text-3 [font-variant-ligatures:none]"
                    title={row.when}
                  >
                    {row.when ?? ''}
                  </td>
                  <td className="text-[11.5px] text-text-3">
                    {row.source ? SOURCE_LABEL[row.source] : ''}
                  </td>
                  <td>
                    <span
                      className={cn(
                        'flex justify-end gap-0.5 pr-1',
                        !isCurrent && 'opacity-0 group-hover:opacity-100',
                      )}
                    >
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`Change the keybinding of ${row.label}`}
                        title="Change keybinding"
                        className={iconButton}
                        onClick={() => setEditing(row)}
                      >
                        <Pencil />
                      </button>
                      {row.key && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Remove the keybinding of ${row.label}`}
                          title="Remove keybinding"
                          className={iconButton}
                          onClick={() => void removeKeybinding(row)}
                        >
                          <X />
                        </button>
                      )}
                      {row.changed && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label={`Reset ${row.label} to Lathe's keys`}
                          title="Reset to Lathe's"
                          className={iconButton}
                          onClick={() => void resetKeybindings(row.command)}
                        >
                          <RotateCcw />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && (
          <p className="px-2 py-6 text-[12px] text-text-3">No command matches that search.</p>
        )}

        <h2 className="mt-8 mb-2 text-[11px] font-medium tracking-wide text-text-3 uppercase">
          Editing keys
        </h2>
        <p className="mb-2 text-[12px] text-text-3">
          These belong to the editor itself (Vim mode replaces them with Vim&apos;s).
        </p>
        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-6 gap-y-1 text-[12px]">
          {EDITING_KEYS.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt className="text-text-2">{what}</dt>
              <dd className="text-text-3">{keys}</dd>
            </div>
          ))}
        </dl>
      </div>

      {editing && (
        <RecordKeys
          row={editing}
          rows={rows}
          onDone={() => {
            setEditing(null);
            focusRow(Math.max(0, shown.indexOf(editing)));
          }}
        />
      )}
    </div>
  );
}

/** "Press the keys, then Enter": records one key or a two-key chord for a command. */
function RecordKeys({ row, rows, onDone }: { row: Row; rows: Row[]; onDone: () => void }) {
  const [strokes, setStrokes] = useState<string[]>([]);
  const strokesRef = useRef<string[]>([]);
  const dialog = useRef<HTMLDivElement>(null);
  const key = strokes.join(' ');
  const clashes = key
    ? rows.filter((r) => r.key === key && r.command !== row.command).map((r) => r.label)
    : [];

  const save = async (value: string) => {
    onDone();
    if (value && value !== row.key) await changeKeybinding(row, value);
  };

  useEffect(() => {
    dialog.current?.focus();
    suspendKeybindings(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const stroke = keyOf(event);
      if (!stroke) return;
      const recorded = strokesRef.current;
      if (stroke === 'escape') return onDone();
      if (stroke === 'enter' && recorded.length) return void save(recorded.join(' '));
      // A second key makes a chord ("ctrl+k ctrl+s"); a third starts over.
      const next = recorded.length === 1 ? [...recorded, stroke] : [stroke];
      strokesRef.current = next;
      setStrokes(next);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      suspendKeybindings(false);
    };
    // The listener reads the latest keys through the ref; it's installed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0 z-10 grid place-items-start justify-center bg-bg/60 pt-[18vh]">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-keys-title"
        aria-describedby="record-keys-hint"
        tabIndex={-1}
        className="w-[420px] rounded-md border border-line-strong bg-overlay p-4 shadow-pop outline-none"
      >
        <h2 id="record-keys-title" className="text-[12.5px] text-text">
          Keys for <span className="font-medium">{row.label}</span>
        </h2>
        <div
          className="mt-3 grid h-12 place-items-center rounded-md border border-line bg-raised"
          aria-live="polite"
          data-recorded={key}
        >
          {key ? (
            <KeyCaps value={key} className="text-[13px]" />
          ) : (
            <span className="text-[12px] text-text-3">Press the keys you want</span>
          )}
        </div>
        <p id="record-keys-hint" className="mt-2 text-[11.5px] text-text-3">
          A second key makes a chord. Enter saves, Escape cancels.
        </p>
        {clashes.length > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>Also bound to {clashes.join(', ')}.</span>
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-7 rounded-md border border-line px-3 text-[12px] text-text-2 hover:bg-hover"
            onClick={onDone}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!key}
            className="h-7 rounded-md bg-accent px-3 text-[12px] font-medium text-accent-ink disabled:opacity-40"
            onClick={() => void save(key)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
