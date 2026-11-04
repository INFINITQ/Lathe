import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronRight,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ListCollapse,
  RefreshCw,
} from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentsVersion } from '../../editor/documents';
import { backend } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { basename, dirname, pathKey, relative } from '../../lib/paths';
import { executeCommand } from '../../services/commands';
import { keyFor } from '../../services/keybindings';
import { focusSearch } from '../../services/search';
import { decorationsOf, useGit } from '../../services/git';
import { getSetting } from '../../services/settings';
import { ContextMenuArea, type MenuEntry } from '../../ui/Menu';
import { activeTab, openPath, tabPath, useEditors } from '../editors/store';
import { fileIcon, folderIcon } from '../fileIcons';
import { showView } from '../layout';
import { OutlineSection } from './OutlineSection';
import { pickAndOpenFolder, useWorkspace } from '../workspaceStore';
import {
  type Row,
  cancelCreate,
  collapseAll,
  copySelected,
  deleteSelected,
  duplicate,
  finishCreate,
  finishRename,
  loadDir,
  moveInto,
  paste,
  reveal,
  selectOnly,
  selectRange,
  selectedPaths,
  setExpanded,
  startCreate,
  startRename,
  toggleDir,
  toggleSelected,
  useTree,
  visibleRows,
} from './tree';

const ROW = 22;

export function Explorer() {
  const root = useWorkspace((s) => s.root);
  const name = useWorkspace((s) => s.name);
  return (
    <div className="flex h-full min-h-0 flex-col" data-view="explorer">
      <header className="group/header flex h-(--tabs-h) shrink-0 items-center gap-1 pr-2 pl-3">
        <h2 className="flex-1 truncate text-[11px] font-medium tracking-wide text-text-3 uppercase">
          {name ?? 'Explorer'}
        </h2>
        {root && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-(--dur) group-hover/header:opacity-100 focus-within:opacity-100">
            <HeaderButton label="New file" onClick={() => void startCreate(false)}>
              <FilePlus />
            </HeaderButton>
            <HeaderButton label="New folder" onClick={() => void startCreate(true)}>
              <FolderPlus />
            </HeaderButton>
            <HeaderButton label="Refresh" onClick={() => void loadDir(root)}>
              <RefreshCw />
            </HeaderButton>
            <HeaderButton label="Collapse folders" onClick={collapseAll}>
              <ListCollapse />
            </HeaderButton>
          </div>
        )}
      </header>
      {root ? <Tree /> : <NoFolder />}
      <OutlineSection />
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function NoFolder() {
  const recent = useWorkspace((s) => s.recent);
  return (
    <div className="px-3 pt-2 text-[12px] text-text-3">
      <p className="mb-3">You haven’t opened a folder yet.</p>
      <button
        type="button"
        data-autofocus
        onClick={() => void pickAndOpenFolder()}
        className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-accent text-[12px] font-medium text-accent-ink hover:brightness-95"
      >
        <FolderOpen className="size-3.5" />
        Open folder
      </button>
      {recent.length > 0 && (
        <>
          <h3 className="mt-5 mb-1.5 text-[11px] font-medium tracking-wide uppercase">Recent</h3>
          <ul className="flex flex-col gap-0.5">
            {recent.slice(0, 6).map((path) => (
              <li key={path}>
                <button
                  type="button"
                  title={path}
                  className="w-full truncate rounded-sm px-1.5 py-0.5 text-left text-text-2 hover:bg-hover hover:text-text"
                  onClick={() => void executeCommand('workspace.open', path)}
                >
                  {basename(path)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Colours for Git status letters, as in the Source control view. */
const GIT_CLASS: Record<string, string> = {
  M: 'text-warning',
  A: 'text-accent-fg',
  U: 'text-accent-fg',
  D: 'text-danger',
  '!': 'text-danger',
  '•': 'text-warning',
};

/** Git marks by path key: each changed file's letter, and a dot on the folders above it. */
function useGitMarks(): Map<string, string> {
  const repo = useGit((s) => s.repo);
  return useMemo(() => {
    const marks = decorationsOf(repo);
    if (!repo) return marks;
    const root = pathKey(repo.root);
    for (const [key] of [...marks]) {
      let dir = dirname(key);
      while (dir.length > root.length && dir.startsWith(root) && !marks.has(dir)) {
        marks.set(dir, '•');
        dir = dirname(dir);
      }
    }
    return marks;
  }, [repo]);
}

function Tree() {
  const gitMarks = useGitMarks();
  const state = useTree();
  const rows = useMemo(
    () => visibleRows(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.nodes, state.children, state.expanded, state.creating, state.root],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  });
  useDocumentsVersion();
  const activePath = useEditors((s) => {
    const group = s.groups.find((g) => g.id === s.activeGroup);
    const tab = group?.tabs.find((t) => t.id === group.activeTab);
    return tab ? tabPath(tab) : null;
  });
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Auto-reveal: the active editor's file is shown and selected.
  useEffect(() => {
    if (activePath && getSetting('explorer.autoReveal')) void reveal(activePath);
  }, [activePath]);

  // Keep the focused row on screen.
  useEffect(() => {
    if (!state.focused) return;
    const index = rows.findIndex((r) => r.key === state.focused);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [state.focused, rows, virtualizer]);

  const openRow = (row: Row, preview: boolean) => {
    if (row.node.dir) toggleDir(row.node.path);
    else void openPath(row.node.path, { preview });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (state.renaming || state.creating) return;
    const real = rows.filter((r) => !r.input);
    const at = real.findIndex((r) => r.key === state.focused);
    const row = real[at];
    const move = (index: number) => {
      const next = real[Math.max(0, Math.min(real.length - 1, index))];
      if (!next) return;
      if (event.shiftKey) selectRange(next.key);
      else selectOnly(next.key);
    };
    switch (event.key) {
      case 'ArrowDown':
        move(at + 1);
        break;
      case 'ArrowUp':
        move(at < 0 ? 0 : at - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(real.length - 1);
        break;
      case 'PageDown':
        move(at + 15);
        break;
      case 'PageUp':
        move(at - 15);
        break;
      case 'ArrowRight':
        if (row?.node.dir) {
          if (!state.expanded[row.key]) void setExpanded(row.node.path, true);
          else move(at + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.node.dir && state.expanded[row.key]) void setExpanded(row.node.path, false);
        else if (row) {
          const parent = pathKey(dirname(row.node.path));
          if (state.nodes[parent] && parent !== pathKey(state.root ?? '')) selectOnly(parent);
        }
        break;
      case 'Enter':
        if (row) openRow(row, false);
        break;
      case ' ':
        if (row) openRow(row, true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // Drag to move: pointer events (native drag and drop belongs to File Explorer drops).
  const onRowPointerDown = (event: PointerEvent, row: Row) => {
    if (event.button !== 0 || state.renaming) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const paths = state.selected.includes(row.key) ? selectedPaths() : [row.node.path];
    const folderAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-row]');
      if (!el) return state.root;
      const node = useTree.getState().nodes[el.dataset.row ?? ''];
      if (!node) return state.root;
      return node.dir ? node.path : dirname(node.path);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 5) {
        dragging = true;
        document.body.dataset.dragging = 'files';
      }
      if (dragging) setDropTarget(folderAt(e.clientX, e.clientY));
    };
    const onUp = (e: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      delete document.body.dataset.dragging;
      setDropTarget(null);
      if (!dragging) return;
      const folder = folderAt(e.clientX, e.clientY);
      if (folder) void moveInto(paths, folder);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const menu = (): MenuEntry[] => {
    const paths = selectedPaths();
    const single = paths.length === 1 ? paths[0]! : null;
    const node = state.focused ? state.nodes[state.focused] : undefined;
    const root = state.root!;
    return [
      { label: 'New file…', run: () => void startCreate(false) },
      { label: 'New folder…', run: () => void startCreate(true) },
      'separator',
      ...(single && !node?.dir
        ? ([
            { label: 'Open to the side', run: () => void openPath(single, { group: 'side' }) },
            'separator',
          ] as MenuEntry[])
        : []),
      ...(single && node?.dir
        ? ([
            {
              label: 'Find in folder…',
              run: () => {
                showView('search');
                focusSearch({ include: `./${relative(root, single)}` });
              },
            },
            'separator',
          ] as MenuEntry[])
        : []),
      { label: 'Reveal in File Explorer', run: () => void backend().fs.reveal(single ?? root) },
      ...(single
        ? ([
            {
              label: 'Copy path',
              run: () => void navigator.clipboard.writeText(single),
            },
            {
              label: 'Copy relative path',
              run: () => void navigator.clipboard.writeText(relative(root, single)),
            },
          ] as MenuEntry[])
        : []),
      'separator',
      { label: 'Cut', shortcut: 'Ctrl+X', run: () => copySelected(true), disabled: !paths.length },
      {
        label: 'Copy',
        shortcut: 'Ctrl+C',
        run: () => copySelected(false),
        disabled: !paths.length,
      },
      { label: 'Paste', shortcut: 'Ctrl+V', run: () => void paste(), disabled: !state.clipboard },
      { label: 'Duplicate', run: () => void duplicate(), disabled: !paths.length },
      'separator',
      {
        label: 'Rename…',
        shortcut: keyFor('explorer.rename'),
        run: () => startRename(),
        disabled: !single,
      },
      {
        label: 'Delete',
        shortcut: keyFor('explorer.delete'),
        run: () => void deleteSelected(),
        disabled: !paths.length,
        danger: true,
      },
    ];
  };

  return (
    <ContextMenuArea entries={menu}>
      <div
        ref={scroller}
        role="tree"
        aria-label="Files"
        aria-multiselectable="true"
        tabIndex={0}
        data-autofocus
        className="min-h-0 flex-1 overflow-auto pb-6 outline-none"
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
          const key = el?.dataset.row;
          if (key && !state.selected.includes(key)) selectOnly(key);
          if (!key) useTree.setState({ focused: null, selected: [] });
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
                {row.input ? (
                  <NameInput
                    depth={row.depth}
                    dir={row.input === 'newFolder'}
                    initial=""
                    onDone={(value) => {
                      if (value === null) cancelCreate();
                      else
                        void finishCreate(value).then((path) => {
                          if (path && row.input === 'newFile') void openPath(path);
                        });
                    }}
                  />
                ) : state.renaming === row.key ? (
                  <NameInput
                    depth={row.depth}
                    dir={row.node.dir}
                    initial={row.node.name}
                    onDone={(value) => {
                      if (value === null) useTree.setState({ renaming: null });
                      else void finishRename(value);
                    }}
                  />
                ) : (
                  <TreeRow
                    row={row}
                    expanded={!!state.expanded[row.key]}
                    selected={state.selected.includes(row.key)}
                    focused={state.focused === row.key}
                    active={!!activePath && pathKey(activePath) === row.key}
                    cut={
                      !!state.clipboard?.cut &&
                      state.clipboard.paths.some((p) => pathKey(p) === row.key)
                    }
                    dropTarget={!!dropTarget && row.node.dir && pathKey(dropTarget) === row.key}
                    git={gitMarks.get(row.key)}
                    onPointerDown={(e) => onRowPointerDown(e, row)}
                    onClick={(e) => {
                      if (e.ctrlKey) return toggleSelected(row.key);
                      if (e.shiftKey) return selectRange(row.key);
                      selectOnly(row.key);
                      openRow(row, true);
                    }}
                    onDoubleClick={() => {
                      if (!row.node.dir) void openPath(row.node.path, { preview: false });
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </ContextMenuArea>
  );
}

function TreeRow({
  row,
  expanded,
  selected,
  focused,
  active,
  cut,
  dropTarget,
  git,
  onPointerDown,
  onClick,
  onDoubleClick,
}: {
  row: Row;
  expanded: boolean;
  selected: boolean;
  focused: boolean;
  active: boolean;
  cut: boolean;
  dropTarget: boolean;
  /** A Git status letter (files) or "•" (folders with changes inside). */
  git?: string;
  onPointerDown: (e: PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const { node, depth } = row;
  const Icon = node.dir ? folderIcon(node.name, expanded) : fileIcon(node.name);
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.dir ? expanded : undefined}
      aria-level={depth + 1}
      data-row={row.key}
      title={node.path}
      className={cn(
        'flex h-full cursor-default items-center gap-1.5 pr-2 text-[12.5px] whitespace-nowrap',
        selected ? 'bg-active text-text' : 'text-text-2 hover:bg-hover hover:text-text',
        focused && 'shadow-[inset_0_0_0_1px_var(--line-strong)]',
        active && !selected && 'text-text',
        dropTarget && 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent-fg)]',
        (node.hidden || cut) && 'opacity-60',
      )}
      style={{ paddingLeft: 8 + depth * 12 }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="grid size-3.5 shrink-0 place-items-center text-text-3">
        {node.dir && (
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-(--dur)',
              expanded && 'rotate-90',
            )}
          />
        )}
      </span>
      <Icon
        className={cn('size-3.5 shrink-0', active ? 'text-accent-fg' : 'text-text-3')}
        strokeWidth={1.75}
      />
      <span className={cn('truncate', git && GIT_CLASS[git], git === 'D' && 'line-through')}>
        {node.name}
      </span>
      {node.link && <span className="text-[10.5px] text-text-4">↗</span>}
      {git && (
        <span
          className={cn(
            'ml-auto shrink-0 pl-1 font-mono text-[10.5px]',
            GIT_CLASS[git] ?? 'text-text-3',
          )}
        >
          {git}
        </span>
      )}
    </div>
  );
}

/** The inline input for a new entry or a rename. Enter confirms, Escape cancels. */
function NameInput({
  depth,
  dir,
  initial,
  onDone,
}: {
  depth: number;
  dir: boolean;
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // Select the name without its extension, as Explorer does.
    const dot = dir ? -1 : initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [dir, initial]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const Icon = dir ? folderIcon('', false) : fileIcon(initial || 'file');
  return (
    <div
      className="flex h-full items-center gap-1.5 pr-2"
      style={{ paddingLeft: 8 + depth * 12 + 20 }}
    >
      <Icon className="size-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
      <input
        ref={input}
        defaultValue={initial}
        aria-label={dir ? 'Folder name' : 'File name'}
        spellCheck={false}
        className="h-[20px] min-w-0 flex-1 rounded-sm border border-accent-fg bg-bg px-1 text-[12.5px] text-text outline-none select-text"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(e.currentTarget.value.trim());
          if (e.key === 'Escape') finish(null);
        }}
        onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      />
    </div>
  );
}

/** Opens the explorer on the active editor's file (Reveal active file). */
export async function revealActiveFile() {
  const { tab } = activeTab();
  const path = tab ? tabPath(tab) : null;
  if (path) await reveal(path);
}
