import {
  Bug,
  ChevronRight,
  Columns2,
  Ellipsis,
  Eye,
  Keyboard,
  Pin,
  Play,
  Settings2,
  X,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { SymbolIcon } from '../../editor/SymbolIcon';
import { TextEditor } from '../../editor/TextEditor';
import { getDocument, useDocumentsVersion } from '../../editor/documents';
import { revealSymbol, useOutline } from '../../editor/outline';
import { symbolPath } from '../../editor/symbols';
import { backend } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { relative } from '../../lib/paths';
import { canRun, runActiveFile } from '../../run/run';
import { canDebug } from '../../debug/launch';
import { debugActiveFile } from '../../debug/manager';
import { keyFor } from '../../services/keybindings';
import { getSetting } from '../../services/settings';
import { ContextMenuArea, DropdownMenuButton, type MenuEntry } from '../../ui/Menu';
import { fileIcon } from '../fileIcons';
import { useWorkspace } from '../workspaceStore';
import { DiffEditor } from './DiffEditor';
import { NotebookEditor } from '../../notebook/NotebookEditor';
import { ImageViewer } from './ImageViewer';
import { KeybindingsEditor } from './KeybindingsEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { SettingsEditor } from './SettingsEditor';
import { Welcome } from './Welcome';
import {
  type Group,
  type Tab,
  activateTab,
  closeTab,
  closeTabs,
  focusGroup,
  keepTab,
  moveTab,
  setPinned,
  splitGroup,
  tabPath,
  tabTitle,
  useEditors,
} from './store';

/** One editor group: its tab strip, breadcrumbs and the active tab's editor. */
export function EditorGroupView({ group, index }: { group: Group; index: number }) {
  useDocumentsVersion();
  const activeGroup = useEditors((s) => s.activeGroup);
  const isActive = activeGroup === group.id;
  const tab = group.tabs.find((t) => t.id === group.activeTab) ?? null;
  // Files get breadcrumbs; the diff editor has its own header, and Lathe's own pages need none.
  const showBreadcrumbs =
    tab && (tab.kind === 'text' || tab.kind === 'notebook' || tab.kind === 'image');

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={`Editor group ${index + 1}`}
      data-group={group.id}
      data-active={isActive}
      onPointerDownCapture={() => {
        if (!isActive) focusGroup(group.id);
      }}
    >
      {group.tabs.length > 0 && <TabStrip group={group} isActive={isActive} />}
      {showBreadcrumbs && <Breadcrumbs tab={tab} />}
      <div className="relative min-h-0 flex-1">
        {tab?.kind === 'text' && tab.docId ? (
          <TextEditor
            key={tab.id}
            groupId={group.id}
            tabId={tab.id}
            docId={tab.docId}
            focusOnMount
          />
        ) : tab?.kind === 'notebook' && tab.docId && getDocument(tab.docId) ? (
          <NotebookEditor key={tab.id} doc={getDocument(tab.docId)!} />
        ) : tab?.kind === 'image' && tab.path ? (
          <ImageViewer key={tab.id} path={tab.path} />
        ) : tab?.kind === 'diff' && tab.diff ? (
          <DiffEditor key={tab.id} spec={tab.diff} groupId={group.id} tabId={tab.id} />
        ) : tab?.kind === 'keybindings' ? (
          <KeybindingsEditor key={tab.id} />
        ) : tab?.kind === 'settings' ? (
          <SettingsEditor key={tab.id} />
        ) : tab?.kind === 'preview' ? (
          <MarkdownPreview key={tab.id} tab={tab} />
        ) : tab?.kind === 'welcome' || group.tabs.length === 0 ? (
          index === 0 ? (
            <Welcome />
          ) : (
            <div className="h-full" />
          )
        ) : null}
      </div>
    </section>
  );
}

function TabStrip({ group, isActive }: { group: Group; isActive: boolean }) {
  const strip = useRef<HTMLDivElement>(null);
  const activeTab = group.tabs.find((t) => t.id === group.activeTab);
  const activeDoc =
    activeTab?.kind === 'text' && activeTab.docId ? getDocument(activeTab.docId) : null;
  const runnable = canRun(activeDoc?.languageId);
  const debuggable = !!activeDoc?.path && canDebug(activeDoc.languageId);
  const [drag, setDrag] = useState<{ tabId: string; over: number } | null>(null);

  // Pointer-based dragging (native drag and drop belongs to File Explorer drops).
  const startDrag = (event: ReactPointerEvent, tab: Tab) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const target = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      const groupEl = el?.closest<HTMLElement>('[data-group]');
      const tabEl = el?.closest<HTMLElement>('[data-tab-index]');
      const groupId = groupEl?.dataset.group ?? group.id;
      let at = Number(tabEl?.dataset.tabIndex ?? -1);
      if (tabEl) {
        const box = tabEl.getBoundingClientRect();
        if (x > box.left + box.width / 2) at += 1;
      }
      return { groupId, at };
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > 5) dragging = true;
      if (!dragging) return;
      const { groupId, at } = target(e.clientX, e.clientY);
      setDrag({ tabId: tab.id, over: groupId === group.id ? at : -1 });
      document.body.dataset.dragging = 'tab';
    };
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      delete document.body.dataset.dragging;
      setDrag(null);
      if (!dragging) return;
      const { groupId, at } = target(e.clientX, e.clientY);
      const groupTabs = useEditors.getState().groups.find((g) => g.id === groupId)?.tabs ?? [];
      const index = at < 0 ? groupTabs.length : at;
      const from = group.tabs.findIndex((t) => t.id === tab.id);
      moveTab(group.id, tab.id, groupId, groupId === group.id && index > from ? index - 1 : index);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex h-(--tabs-h) shrink-0 items-stretch border-b border-line bg-bg">
      <div
        ref={strip}
        role="tablist"
        aria-label="Open editors"
        className="tabstrip flex min-w-0 flex-1 items-stretch overflow-x-auto"
        onWheel={(e) => {
          if (strip.current && e.deltaY) strip.current.scrollLeft += e.deltaY;
        }}
      >
        {group.tabs.map((tab, i) => (
          <TabButton
            key={tab.id}
            tab={tab}
            index={i}
            group={group}
            active={tab.id === group.activeTab}
            groupActive={isActive}
            dropBefore={drag?.over === i}
            dropAfter={drag?.over === group.tabs.length && i === group.tabs.length - 1}
            onPointerDown={(e) => startDrag(e, tab)}
          />
        ))}
        <div className="flex-1" />
      </div>
      <div className="flex items-center gap-0.5 px-1.5">
        {runnable && (
          <button
            type="button"
            aria-label={`Run file (${keyFor('run.file') ?? 'Ctrl+F5'})`}
            title={`Run file (${keyFor('run.file') ?? 'Ctrl+F5'})`}
            data-action="run-file"
            className="grid size-6 place-items-center rounded-sm text-accent-fg hover:bg-hover"
            onClick={() => void runActiveFile()}
          >
            <Play className="size-3.5" />
          </button>
        )}
        {debuggable && (
          <button
            type="button"
            aria-label="Debug this file"
            title="Debug this file"
            data-action="debug-file"
            className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            onClick={() => void debugActiveFile()}
          >
            <Bug className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label={`Split editor right (${keyFor('view.splitRight') ?? 'Ctrl+\\'})`}
          title={`Split editor right (${keyFor('view.splitRight') ?? 'Ctrl+\\'})`}
          className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
          onClick={() => splitGroup('right')}
        >
          <Columns2 className="size-3.5" />
        </button>
        <DropdownMenuButton
          align="end"
          trigger={
            <button
              type="button"
              aria-label="More actions"
              title="More actions"
              className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            >
              <Ellipsis className="size-3.5" />
            </button>
          }
          entries={[
            { label: 'Close all', run: () => void closeTabs(group.id, 'all') },
            { label: 'Close saved', run: () => void closeTabs(group.id, 'saved') },
            'separator',
            { label: 'Split down', run: () => void splitGroup('down') },
          ]}
        />
      </div>
    </div>
  );
}

function TabButton({
  tab,
  index,
  group,
  active,
  groupActive,
  dropBefore,
  dropAfter,
  onPointerDown,
}: {
  tab: Tab;
  index: number;
  group: Group;
  active: boolean;
  groupActive: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const doc = tab.docId ? getDocument(tab.docId) : undefined;
  const title = tabTitle(tab);
  const path = tabPath(tab);
  const root = useWorkspace((s) => s.root);
  const Icon =
    tab.kind === 'keybindings'
      ? Keyboard
      : tab.kind === 'settings'
        ? Settings2
        : tab.kind === 'preview'
          ? Eye
          : fileIcon(title);
  const dirty = doc?.dirty ?? false;
  const menu = (): MenuEntry[] => [
    {
      label: 'Close',
      shortcut: keyFor('editor.close'),
      run: () => void closeTab(group.id, tab.id),
    },
    { label: 'Close others', run: () => void closeTabs(group.id, 'others', tab.id) },
    { label: 'Close to the right', run: () => void closeTabs(group.id, 'right', tab.id) },
    { label: 'Close saved', run: () => void closeTabs(group.id, 'saved') },
    { label: 'Close all', run: () => void closeTabs(group.id, 'all') },
    'separator',
    tab.pinned
      ? { label: 'Unpin', run: () => setPinned(group.id, tab.id, false) }
      : { label: 'Pin', run: () => setPinned(group.id, tab.id, true) },
    ...(path
      ? ([
          'separator',
          { label: 'Copy path', run: () => void navigator.clipboard.writeText(path) },
          ...(root
            ? [
                {
                  label: 'Copy relative path',
                  run: () => void navigator.clipboard.writeText(relative(root, path)),
                },
              ]
            : []),
          { label: 'Reveal in File Explorer', run: () => void backend().fs.reveal(path) },
        ] as MenuEntry[])
      : []),
    'separator',
    {
      label: 'Split right',
      run: () => {
        activateTab(group.id, tab.id);
        splitGroup('right');
      },
    },
  ];
  return (
    <ContextMenuArea entries={menu}>
      <div
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-tab-index={index}
        title={path ? (root ? relative(root, path) : path) : title}
        className={cn(
          'tab group/tab relative flex min-w-0 max-w-[220px] shrink-0 cursor-default items-center gap-1.5 border-r border-line pr-1.5 pl-3 text-[12px] transition-colors duration-(--dur)',
          active ? 'bg-bg text-text' : 'bg-raised text-text-3 hover:text-text-2',
          dropBefore && 'shadow-[inset_2px_0_0_var(--accent-fg)]',
          dropAfter && 'shadow-[inset_-2px_0_0_var(--accent-fg)]',
        )}
        onPointerDown={onPointerDown}
        onClick={() => activateTab(group.id, tab.id)}
        onDoubleClick={() => keepTab(group.id, tab.id)}
        onAuxClick={(e) => {
          if (e.button === 1) void closeTab(group.id, tab.id);
        }}
      >
        {active && (
          <span
            className={cn(
              'absolute inset-x-0 bottom-[-1px] h-px',
              groupActive ? 'bg-accent-fg' : 'bg-text-4',
            )}
            aria-hidden="true"
          />
        )}
        {tab.kind !== 'welcome' && (
          <Icon className="size-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
        )}
        <span className={cn('truncate', tab.preview && 'italic', doc?.deleted && 'line-through')}>
          {title}
        </span>
        {/* Close and Unpin are for the mouse: a tab can't hold buttons of its own (it is one),
            and the keyboard has Ctrl+W, Ctrl+F4 and the tab's menu (Shift+F10). */}
        {tab.pinned ? (
          <span
            aria-hidden="true"
            data-action="unpin"
            title="Unpin"
            className="grid size-5 shrink-0 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPinned(group.id, tab.id, false);
            }}
          >
            <Pin className="size-3" />
          </span>
        ) : (
          <span className="relative grid size-5 shrink-0 place-items-center">
            {dirty && (
              <span
                role="img"
                aria-label="Unsaved"
                className="absolute size-2 rounded-full bg-text-2 group-hover/tab:hidden"
              />
            )}
            <span
              aria-hidden="true"
              data-action="close-tab"
              title={`Close (${keyFor('editor.close') ?? 'Ctrl+W'})`}
              className={cn(
                'grid size-5 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text',
                !active && !dirty && 'opacity-0 group-hover/tab:opacity-100',
                dirty && 'opacity-0 group-hover/tab:opacity-100',
              )}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(group.id, tab.id);
              }}
            >
              <X className="size-3.5" />
            </span>
          </span>
        )}
      </div>
    </ContextMenuArea>
  );
}

/** "src › editor › theme.ts" under the tabs. */
function Breadcrumbs({ tab }: { tab: Tab }) {
  const root = useWorkspace((s) => s.root);
  const outline = useOutline();
  const path = tabPath(tab);
  const parts = path
    ? (root ? relative(root, path) : path).split(/[\\/]/).filter(Boolean)
    : [tabTitle(tab)];
  // The symbols around the cursor, when this tab's document is in the active editor.
  const doc = tab.docId ? getDocument(tab.docId) : undefined;
  const mine = !!outline.view && !!doc?.views.has(outline.view);
  const symbols =
    mine && getSetting('breadcrumbs.symbolPath') ? symbolPath(outline.symbols, outline.cursor) : [];
  return (
    <nav
      aria-label="Breadcrumbs"
      className="flex h-[22px] shrink-0 items-center gap-0.5 overflow-hidden px-3 text-[11px] text-text-3"
    >
      {parts.map((part, i) => (
        <span key={i} className="flex shrink-0 items-center gap-0.5">
          {i > 0 && <ChevronRight className="size-3 text-text-4" />}
          <span className={i === parts.length - 1 && !symbols.length ? 'text-text-2' : ''}>
            {part}
          </span>
        </span>
      ))}
      {symbols.map((symbol, i) => (
        <span key={`${symbol.from}`} className="flex min-w-0 items-center gap-0.5">
          <ChevronRight className="size-3 shrink-0 text-text-4" />
          <button
            type="button"
            className={cn(
              'flex min-w-0 items-center gap-1 rounded-sm px-0.5 hover:bg-hover hover:text-text',
              i === symbols.length - 1 && 'text-text-2',
            )}
            title={`Go to ${symbol.name}`}
            onClick={() => outline.view && revealSymbol(outline.view, symbol)}
          >
            <SymbolIcon kind={symbol.kind} className="size-3" />
            <span className="truncate">{symbol.name}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}
