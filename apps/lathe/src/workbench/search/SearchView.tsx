import { useVirtualizer } from '@tanstack/react-virtual';
import {
  BookCheck,
  CaseSensitive,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  RefreshCw,
  Regex,
  Replace,
  ReplaceAll,
  WholeWord,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { FileMatches, SearchMatch } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { basename, dirname, pathKey, relative } from '../../lib/paths';
import {
  type SearchState,
  clearSearch,
  dismissFile,
  dismissMatch,
  matchCount,
  openMatch,
  previewReplacement,
  replaceAll,
  replaceInFile,
  replaceMatch,
  runSearch,
  searchIfChanged,
  useSearch,
} from '../../services/search';
import { getSetting } from '../../services/settings';
import { fileIcon } from '../fileIcons';
import { useWorkspace } from '../workspaceStore';

const ROW = 22;

type Row =
  | { kind: 'file'; key: string; file: FileMatches }
  | { kind: 'match'; key: string; file: FileMatches; match: SearchMatch };

function rowsOf(files: FileMatches[], collapsed: Record<string, true>): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    const key = pathKey(file.path);
    rows.push({ kind: 'file', key, file });
    if (collapsed[key]) continue;
    file.matches.forEach((match, i) =>
      rows.push({ kind: 'match', key: `${key}#${i}`, file, match }),
    );
  }
  return rows;
}

const set = (patch: Partial<SearchState>) => useSearch.setState(patch);

/** The Search view (Ctrl+Shift+F): search the open folder, and replace across it. */
export function SearchView() {
  const state = useSearch();
  const root = useWorkspace((s) => s.root);
  const input = useRef<HTMLInputElement>(null);

  // Ctrl+Shift+F (again) focuses and selects the search box.
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [state.focusRequest]);

  // Search as you type, a moment after the last change.
  const { pattern, isRegex, matchCase, wholeWord, include, exclude, useExcludeSettings } = state;
  useEffect(() => {
    if (!getSetting('search.searchOnType')) return;
    const timer = setTimeout(searchIfChanged, getSetting('search.searchOnTypeDebouncePeriod'));
    return () => clearTimeout(timer);
  }, [pattern, isRegex, matchCase, wholeWord, include, exclude, useExcludeSettings, root]);

  const allCollapsed =
    state.files.length > 0 && state.files.every((f) => state.collapsed[pathKey(f.path)]);
  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    } else if (event.key === 'Escape' && state.running) {
      clearSearch();
    } else if (event.altKey && !event.ctrlKey) {
      const toggle = { c: 'matchCase', w: 'wholeWord', r: 'isRegex' } as const;
      const name = toggle[event.key.toLowerCase() as keyof typeof toggle];
      if (name) {
        event.preventDefault();
        set({ [name]: !state[name] });
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-view="search">
      <header className="group/header flex h-(--tabs-h) shrink-0 items-center gap-1 pr-2 pl-3">
        <h2 className="flex-1 truncate text-[11px] font-medium tracking-wide text-text-3 uppercase">
          Search
        </h2>
        <IconButton label="Refresh" onClick={() => void runSearch()} disabled={!state.pattern}>
          <RefreshCw className={cn(state.running && 'animate-spin')} />
        </IconButton>
        <IconButton label="Clear results" onClick={clearSearch} disabled={!state.pattern}>
          <X />
        </IconButton>
        <IconButton
          label={allCollapsed ? 'Expand all' : 'Collapse all'}
          disabled={!state.files.length}
          onClick={() =>
            set({
              collapsed: allCollapsed
                ? {}
                : Object.fromEntries(state.files.map((f) => [pathKey(f.path), true as const])),
            })
          }
        >
          {allCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
        </IconButton>
      </header>

      <div className="flex shrink-0 gap-1 pr-2 pl-1">
        <button
          type="button"
          aria-label="Toggle replace"
          aria-expanded={state.replaceOpen}
          title="Toggle replace (Ctrl+Shift+H)"
          className="grid w-5 shrink-0 place-items-center self-stretch rounded-sm text-text-3 hover:bg-hover hover:text-text"
          onClick={() => set({ replaceOpen: !state.replaceOpen })}
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-(--dur)',
              state.replaceOpen && 'rotate-90',
            )}
          />
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <Field
            inputRef={input}
            label="Search"
            value={state.pattern}
            onChange={(v) => set({ pattern: v })}
            onKeyDown={searchKeys}
            invalid={!!state.error}
          >
            <Toggle
              label="Match case (Alt+C)"
              on={state.matchCase}
              onClick={() => set({ matchCase: !state.matchCase })}
            >
              <CaseSensitive />
            </Toggle>
            <Toggle
              label="Match whole word (Alt+W)"
              on={state.wholeWord}
              onClick={() => set({ wholeWord: !state.wholeWord })}
            >
              <WholeWord />
            </Toggle>
            <Toggle
              label="Use regular expression (Alt+R)"
              on={state.isRegex}
              onClick={() => set({ isRegex: !state.isRegex })}
            >
              <Regex />
            </Toggle>
          </Field>
          {state.replaceOpen && (
            <Field
              label="Replace"
              value={state.replacement}
              onChange={(v) => set({ replacement: v })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.ctrlKey && event.altKey) {
                  event.preventDefault();
                  void replaceAll();
                }
              }}
            >
              <IconButton
                label="Replace all (Ctrl+Alt+Enter)"
                disabled={!state.files.length}
                onClick={() => void replaceAll()}
              >
                <ReplaceAll />
              </IconButton>
            </Field>
          )}
        </div>
      </div>

      <div className="flex shrink-0 justify-end pr-2">
        <IconButton
          label="Toggle search details"
          pressed={state.detailsOpen}
          onClick={() => set({ detailsOpen: !state.detailsOpen })}
        >
          <Ellipsis />
        </IconButton>
      </div>
      {state.detailsOpen && (
        <div className="shrink-0 space-y-1.5 pr-2 pb-1 pl-7">
          <label className="block text-[11px] text-text-3">
            files to include
            <Field
              label="Files to include"
              placeholder="e.g. *.ts, src/**"
              value={state.include}
              onChange={(v) => set({ include: v })}
              onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            />
          </label>
          <label className="block text-[11px] text-text-3">
            files to exclude
            <Field
              label="Files to exclude"
              placeholder="e.g. *.min.js, dist"
              value={state.exclude}
              onChange={(v) => set({ exclude: v })}
              onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
            >
              <Toggle
                label="Use exclude settings and ignore files"
                on={state.useExcludeSettings}
                onClick={() => set({ useExcludeSettings: !state.useExcludeSettings })}
              >
                <BookCheck />
              </Toggle>
            </Field>
          </label>
        </div>
      )}

      <Summary state={state} hasRoot={!!root} />
      <Results state={state} root={root} />
    </div>
  );
}

function Summary({ state, hasRoot }: { state: SearchState; hasRoot: boolean }) {
  let text: ReactNode = null;
  if (!hasRoot) text = 'Open a folder to search it.';
  else if (state.error) text = <span className="text-danger">{state.error}</span>;
  else if (state.running && !state.files.length) text = 'Searching…';
  else if (state.summary && !state.files.length) text = 'No results found.';
  else if (state.files.length) {
    const count = matchCount(state.files);
    text = `${count} ${count === 1 ? 'result' : 'results'} in ${state.files.length} ${state.files.length === 1 ? 'file' : 'files'}${state.summary?.limitHit ? ' (stopped at the limit; narrow the search)' : ''}`;
  }
  if (!text) return null;
  const unreadable = state.summary?.unreadable ?? 0;
  return (
    <p
      className="shrink-0 px-3 pt-0.5 pb-1.5 text-[11.5px] text-text-3"
      role="status"
      aria-live="polite"
      data-running={state.running}
      data-elapsed={state.summary?.elapsedMs}
      data-matches={state.summary?.matches}
    >
      {text}
      {unreadable > 0 && (
        <span className="block text-warning" title={state.summary?.firstUnreadable ?? undefined}>
          {unreadable} {unreadable === 1 ? "file couldn't" : "files couldn't"} be read.
        </span>
      )}
    </p>
  );
}

function Results({ state, root }: { state: SearchState; root: string | null }) {
  const rows = useMemo(() => rowsOf(state.files, state.collapsed), [state.files, state.collapsed]);
  const scroller = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  });
  const focusIndex = rows.findIndex((r) => r.key === focused);

  useEffect(() => {
    if (focusIndex >= 0) virtualizer.scrollToIndex(focusIndex, { align: 'auto' });
  }, [focusIndex, virtualizer]);

  const toggle = (key: string) =>
    useSearch.setState((s) => {
      const collapsed = { ...s.collapsed };
      if (collapsed[key]) delete collapsed[key];
      else collapsed[key] = true;
      return { collapsed };
    });

  const activate = (row: Row, preserveFocus: boolean) => {
    if (row.kind === 'file') toggle(row.key);
    else openMatch(row.file.path, row.match, { preserveFocus });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const index = Math.max(0, focusIndex);
    const row = rows[focusIndex];
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) setFocused(next.key);
    };
    switch (event.key) {
      case 'ArrowDown':
        move(focusIndex < 0 ? 0 : index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.kind === 'file' && state.collapsed[row.key]) toggle(row.key);
        else move(index + 1);
        break;
      case 'ArrowLeft':
        if (row?.kind === 'file' && !state.collapsed[row.key]) toggle(row.key);
        else if (row?.kind === 'match') setFocused(pathKey(row.file.path));
        break;
      case 'Enter':
        if (row) activate(row, false);
        break;
      case ' ':
        if (row) activate(row, true);
        break;
      case 'Delete':
        if (row?.kind === 'file') dismissFile(row.file.path);
        else if (row) dismissMatch(row.file.path, row.match);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={scroller}
      role="tree"
      aria-label="Search results"
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto pb-6 outline-none"
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (!focused && rows[0]) setFocused(rows[0].key);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={row.key}
              className="absolute inset-x-0"
              style={{ top: 0, height: ROW, transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'file' ? (
                <FileRow
                  file={row.file}
                  root={root}
                  collapsed={!!state.collapsed[row.key]}
                  focused={focused === row.key}
                  replaceOpen={state.replaceOpen}
                  onClick={() => {
                    setFocused(row.key);
                    toggle(row.key);
                  }}
                />
              ) : (
                <MatchRow
                  file={row.file}
                  match={row.match}
                  state={state}
                  focused={focused === row.key}
                  onClick={(side) => {
                    setFocused(row.key);
                    openMatch(row.file.path, row.match, { preserveFocus: true, side });
                  }}
                  onDoubleClick={() => openMatch(row.file.path, row.match)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileRow({
  file,
  root,
  collapsed,
  focused,
  replaceOpen,
  onClick,
}: {
  file: FileMatches;
  root: string | null;
  collapsed: boolean;
  focused: boolean;
  replaceOpen: boolean;
  onClick: () => void;
}) {
  const name = basename(file.path);
  const Icon = fileIcon(name);
  const folder = root ? relative(root, dirname(file.path)) : dirname(file.path);
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={!collapsed}
      aria-selected={focused}
      title={file.path}
      className={cn(
        'group flex h-full cursor-default items-center gap-1.5 pr-2 pl-2 text-[12.5px] whitespace-nowrap text-text-2 hover:bg-hover hover:text-text',
        focused && 'bg-active text-text',
      )}
      onClick={onClick}
    >
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-text-3 transition-transform duration-(--dur)',
          !collapsed && 'rotate-90',
        )}
      />
      <Icon className="size-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
      <span className="shrink-0 text-text">{name}</span>
      <span className="min-w-0 truncate text-[11px] text-text-3">
        {folder === '.' ? '' : folder}
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        {replaceOpen && (
          <IconButton
            label={`Replace all in ${name}`}
            onClick={() => void replaceInFile(file.path)}
            stop
          >
            <ReplaceAll />
          </IconButton>
        )}
        <IconButton label={`Dismiss ${name}`} onClick={() => dismissFile(file.path)} stop>
          <X />
        </IconButton>
      </span>
      <span className="ml-1 min-w-4 rounded-full bg-raised px-1.5 text-center text-[10.5px] text-text-2 group-hover:hidden">
        {file.matches.length}
      </span>
    </div>
  );
}

/** Keeps the match in view in a narrow sidebar: long text before it shows only its end. */
function trimBefore(text: string): string {
  const KEEP = 18;
  if (text.length <= KEEP + 8) return text;
  const tail = text.slice(-KEEP);
  const space = tail.indexOf(' ');
  return `…${space > 0 && space < KEEP - 6 ? tail.slice(space) : tail}`;
}

function MatchRow({
  file,
  match,
  state,
  focused,
  onClick,
  onDoubleClick,
}: {
  file: FileMatches;
  match: SearchMatch;
  state: SearchState;
  focused: boolean;
  onClick: (side: boolean) => void;
  onDoubleClick: () => void;
}) {
  const { preview, previewStart, previewLen } = match;
  const before = trimBefore(preview.slice(0, previewStart));
  const found = preview.slice(previewStart, previewStart + previewLen);
  const after = preview.slice(previewStart + previewLen);
  const replacing = state.replaceOpen;
  return (
    <div
      role="treeitem"
      aria-level={2}
      aria-selected={focused}
      title={`Line ${match.line}: ${preview}`}
      className={cn(
        'group flex h-full cursor-default items-center pr-2 pl-9 font-mono text-[12px] whitespace-pre text-text-2 hover:bg-hover',
        focused && 'bg-active',
      )}
      onClick={(e) => onClick(e.ctrlKey)}
      onDoubleClick={onDoubleClick}
    >
      <span className="min-w-0 flex-1 truncate">
        {before}
        {replacing ? (
          <>
            <del className="bg-danger/20 text-text decoration-danger">{found}</del>
            <ins className="bg-accent-soft text-text no-underline">
              {previewReplacement(found, state)}
            </ins>
          </>
        ) : (
          <mark className="rounded-[2px] bg-accent-soft text-text">{found}</mark>
        )}
        {after}
      </span>
      <span className="ml-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        {replacing && (
          <IconButton label="Replace" onClick={() => void replaceMatch(file.path, match)} stop>
            <Replace />
          </IconButton>
        )}
        <IconButton label="Dismiss" onClick={() => dismissMatch(file.path, match)} stop>
          <X />
        </IconButton>
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  onKeyDown,
  placeholder,
  invalid,
  inputRef,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  invalid?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'mt-0.5 flex h-7 items-center rounded-md border bg-raised pr-0.5 pl-2 focus-within:border-accent-fg',
        invalid ? 'border-danger' : 'border-line-strong',
      )}
    >
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder ?? label}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-4"
      />
      {children && <div className="flex shrink-0 items-center gap-px">{children}</div>}
    </div>
  );
}

function Toggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded-sm [&>svg]:size-3.5',
        on ? 'bg-accent-soft text-accent-fg' : 'text-text-3 hover:bg-hover hover:text-text',
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  pressed,
  stop,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  /** Keep the click from reaching the row underneath. */
  stop?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        if (stop) e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => stop && e.stopPropagation()}
      className={cn(
        'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-40 [&>svg]:size-3.5',
        pressed && 'text-text',
      )}
    >
      {children}
    </button>
  );
}
