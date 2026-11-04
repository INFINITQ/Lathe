import { ChevronDown, PanelBottom, PanelLeft, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type WindowControls, backend } from '../lib/backend';
import { cn } from '../lib/cn';
import { basename, dirname } from '../lib/paths';
import { executeCommand, getCommand } from '../services/commands';
import { keyFor } from '../services/keybindings';
import { DropdownMenuButton, type MenuEntry, type MenuItem } from '../ui/Menu';
import { useLayout } from './layout';
import { openQuickOpen } from './quickinput/store';
import { useWorkspace } from './workspaceStore';

/** A menu item that runs a command, with its title and key. */
function cmd(id: string, label?: string): MenuItem {
  return {
    label: label ?? getCommand(id)?.title ?? id,
    shortcut: keyFor(id),
    run: () => void executeCommand(id),
  };
}

function appMenu(): MenuEntry[] {
  const recent = useWorkspace.getState().recent;
  return [
    {
      label: 'File',
      items: [
        cmd('file.new', 'New file'),
        cmd('file.openFile', 'Open file…'),
        cmd('file.openFolder', 'Open folder…'),
        {
          label: 'Open recent',
          items: recent.length
            ? recent.slice(0, 10).map((path) => ({
                label: basename(path),
                run: () => void executeCommand('workspace.open', path),
              }))
            : [{ label: 'No recent folders', disabled: true }],
        },
        'separator',
        cmd('file.save', 'Save'),
        cmd('file.saveAs', 'Save as…'),
        cmd('file.saveAll', 'Save all'),
        'separator',
        cmd('file.revert', 'Revert file'),
        cmd('editor.close', 'Close editor'),
        cmd('file.closeFolder', 'Close folder'),
        'separator',
        cmd('window.close', 'Exit'),
      ],
    },
    {
      label: 'Edit',
      items: [
        cmd('edit.undo', 'Undo'),
        cmd('edit.redo', 'Redo'),
        'separator',
        cmd('edit.find', 'Find'),
        cmd('edit.replace', 'Replace'),
        'separator',
        cmd('editor.toggleComment', 'Toggle line comment'),
        cmd('editor.toggleBlockComment', 'Toggle block comment'),
      ],
    },
    {
      label: 'Selection',
      items: [
        cmd('edit.selectAll', 'Select all'),
        cmd('editor.expandSelection', 'Expand selection'),
        'separator',
        cmd('editor.copyLineUp', 'Copy line up'),
        cmd('editor.copyLineDown', 'Copy line down'),
        cmd('editor.moveLineUp', 'Move line up'),
        cmd('editor.moveLineDown', 'Move line down'),
        'separator',
        cmd('editor.addCursorAbove', 'Add cursor above'),
        cmd('editor.addCursorBelow', 'Add cursor below'),
        cmd('editor.addNextOccurrence', 'Add next occurrence'),
        cmd('editor.selectAllOccurrences', 'Select all occurrences'),
      ],
    },
    {
      label: 'View',
      items: [
        cmd('quickOpen.commands', 'Command palette…'),
        'separator',
        cmd('view.explorer', 'Explorer'),
        cmd('view.search', 'Search'),
        cmd('view.scm', 'Source control'),
        cmd('view.debug', 'Run and debug'),
        cmd('view.plugins', 'Plugins'),
        'separator',
        cmd('view.problems', 'Problems'),
        cmd('view.output', 'Output'),
        cmd('view.toggleTerminal', 'Terminal'),
        'separator',
        cmd('view.toggleSidebar', 'Toggle sidebar'),
        cmd('view.togglePanel', 'Toggle panel'),
        cmd('view.toggleZen', 'Zen mode'),
        'separator',
        cmd('view.toggleWordWrap', 'Word wrap'),
        cmd('view.toggleMinimap', 'Minimap'),
        cmd('view.splitRight', 'Split editor right'),
        cmd('view.splitDown', 'Split editor down'),
      ],
    },
    {
      label: 'Go',
      items: [
        cmd('quickOpen.files', 'Go to file…'),
        cmd('quickOpen.goToLine', 'Go to line…'),
        'separator',
        cmd('editor.next', 'Next editor'),
        cmd('editor.previous', 'Previous editor'),
        cmd('editor.reopenClosed', 'Reopen closed editor'),
      ],
    },
    {
      label: 'Help',
      items: [
        cmd('help.keyboardShortcuts', 'Keyboard shortcuts'),
        cmd('help.about', 'About Lathe'),
      ],
    },
  ];
}

/** The top strip: Lathe's menu, the folder, the command centre and the window controls. */
export function TitleBar() {
  const focused = useWindowFocus();
  const name = useWorkspace((s) => s.name);
  const root = useWorkspace((s) => s.root);
  const sidebarVisible = useLayout((s) => s.sidebarVisible);
  const panelVisible = useLayout((s) => s.panelVisible);
  return (
    <header
      className="titlebar flex h-(--titlebar-h) shrink-0 items-stretch border-b border-line bg-bg"
      data-focused={focused}
      data-tauri-drag-region
    >
      <div className="flex w-(--rail-w) shrink-0 items-center justify-center">
        <DropdownMenuButton
          trigger={
            <button
              type="button"
              aria-label="Application menu"
              title="Menu"
              className="grid size-7 place-items-center rounded-md hover:bg-hover"
            >
              <LatheMark />
            </button>
          }
          entries={appMenu()}
        />
      </div>
      <div className="flex min-w-0 flex-1 basis-0 items-center" data-tauri-drag-region>
        <DropdownMenuButton
          trigger={
            <button
              type="button"
              className="flex h-6 min-w-0 items-center gap-1 rounded-sm px-1.5 text-[12px] font-medium text-text hover:bg-hover"
              title={root ?? 'No folder open'}
            >
              <span className="truncate">{name ?? 'No folder'}</span>
              <ChevronDown className="size-3 shrink-0 text-text-3" />
            </button>
          }
          entries={[
            cmd('file.openFolder', 'Open folder…'),
            ...(root ? [cmd('file.closeFolder', 'Close folder')] : []),
            'separator',
            ...useWorkspace
              .getState()
              .recent.filter((p) => p !== root)
              .slice(0, 8)
              .map((path) => ({
                label: `${basename(path)}  ${dirname(path)}`,
                run: () => void executeCommand('workspace.open', path),
              })),
          ]}
        />
      </div>
      <div className="flex items-center" data-tauri-drag-region>
        <button
          type="button"
          onClick={() => openQuickOpen('')}
          className="flex h-6 w-[min(420px,38vw)] items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12px] text-text-3 transition-colors duration-(--dur) hover:border-line-strong hover:text-text-2"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">
            {name ? `Search ${name}` : 'Search files and commands'}
          </span>
          <kbd className="font-sans text-[11px] text-text-3">
            {keyFor('quickOpen.files') ?? 'Ctrl+P'}
          </kbd>
        </button>
      </div>
      <div
        className="flex flex-1 basis-0 items-center justify-end gap-0.5 pr-1"
        data-tauri-drag-region
      >
        <ChromeButton
          label={`Toggle sidebar (${keyFor('view.toggleSidebar') ?? 'Ctrl+B'})`}
          pressed={sidebarVisible}
          onClick={() => void executeCommand('view.toggleSidebar')}
        >
          <PanelLeft className="size-3.5" />
        </ChromeButton>
        <ChromeButton
          label={`Toggle panel (${keyFor('view.togglePanel') ?? 'Ctrl+J'})`}
          pressed={panelVisible}
          onClick={() => void executeCommand('view.togglePanel')}
        >
          <PanelBottom className="size-3.5" />
        </ChromeButton>
      </div>
      <CaptionButtons controls={backend().window} />
    </header>
  );
}

/** Lathe's mark: an "L" with a dot, in the accent colour. */
function LatheMark() {
  return (
    <svg viewBox="0 0 1024 1024" className="size-4" aria-hidden="true">
      <path
        d="M368 280v432h304"
        fill="none"
        stroke="var(--accent-fg)"
        strokeWidth="120"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="672" cy="352" r="72" fill="var(--accent-fg)" />
    </svg>
  );
}

function ChromeButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-7 place-items-center rounded-md transition-colors duration-(--dur) hover:bg-hover',
        pressed ? 'text-text-2' : 'text-text-4 hover:text-text-2',
      )}
    >
      {children}
    </button>
  );
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return focused;
}

// Segoe Fluent Icons code points, as Windows 11's own caption buttons use.
const GLYPH = {
  minimize: '',
  maximize: '',
  restore: '',
  close: '',
} as const;

/** Minimize, maximize/restore (with Windows 11 Snap Layouts) and close. */
function CaptionButtons({ controls }: { controls: WindowControls }) {
  const maximize = useRef<HTMLButtonElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [state, setState] = useState<'idle' | 'hover' | 'pressed'>('idle');

  useEffect(() => {
    const report = () => {
      const box = maximize.current?.getBoundingClientRect();
      if (!box) return;
      controls.reportMaximizeRect({
        right: window.innerWidth - box.right,
        top: box.top,
        width: box.width,
        height: box.height,
      });
      void controls.isMaximized().then(setMaximized);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
    const stopResize = controls.onResized(report);
    const stopCaption = controls.onCaption((caption) => {
      setState(caption === 'press' ? 'pressed' : caption === 'leave' ? 'idle' : 'hover');
    });
    return () => {
      observer.disconnect();
      stopResize();
      stopCaption();
    };
  }, [controls]);

  return (
    <div className="caption">
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => controls.minimize()}
      >
        {GLYPH.minimize}
      </button>
      <button
        type="button"
        ref={maximize}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        data-state={state}
        onClick={() => controls.toggleMaximize()}
      >
        {maximized ? GLYPH.restore : GLYPH.maximize}
      </button>
      <button
        type="button"
        className="caption-close"
        aria-label="Close"
        title="Close"
        onClick={() => controls.close()}
      >
        {GLYPH.close}
      </button>
    </div>
  );
}
