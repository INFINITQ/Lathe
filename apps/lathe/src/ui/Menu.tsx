// Menus built on Radix (keyboard navigation, focus handling, nesting), styled Mono.
import { ChevronRight } from 'lucide-react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { cn } from '../lib/cn';

export interface MenuItem {
  label: string;
  /** Shown on the right: "Ctrl+S". */
  shortcut?: string;
  run?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  /** A submenu instead of an action. */
  items?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

const panel =
  'z-50 min-w-[220px] overflow-hidden rounded-md border border-line-strong bg-overlay p-1 text-[12px] text-text shadow-pop';
const row =
  'relative flex h-7 cursor-default select-none items-center gap-3 rounded-sm pr-2 pl-6 outline-none data-[disabled]:text-text-4 data-[highlighted]:bg-active';

type Parts = typeof DropdownMenu | typeof ContextMenu;

function Entries({ parts: P, entries }: { parts: Parts; entries: MenuEntry[] }) {
  return entries.map((entry, i) => {
    if (entry === 'separator') return <P.Separator key={i} className="mx-1 my-1 h-px bg-line" />;
    if (entry.items) {
      return (
        <P.Sub key={i}>
          <P.SubTrigger className={row} disabled={entry.disabled}>
            <span className="flex-1">{entry.label}</span>
            <ChevronRight className="size-3.5 text-text-3" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className={panel} sideOffset={4} alignOffset={-5}>
              <Entries parts={P} entries={entry.items} />
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    return (
      <P.Item
        key={i}
        className={cn(row, entry.danger && 'text-danger')}
        disabled={entry.disabled}
        onSelect={() => entry.run?.()}
      >
        {entry.checked && (
          <span className="absolute left-2 size-1.5 rounded-full bg-accent-fg" aria-hidden="true" />
        )}
        <span className="flex-1 truncate">{entry.label}</span>
        {entry.shortcut && <span className="text-[11px] text-text-3">{entry.shortcut}</span>}
      </P.Item>
    );
  });
}

/** A button that opens a menu. */
export function DropdownMenuButton({
  trigger,
  entries,
  align = 'start',
}: {
  trigger: ReactNode;
  entries: MenuEntry[];
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={panel} sideOffset={4} align={align}>
          <Entries parts={DropdownMenu} entries={entries} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Right-click anywhere inside `children` opens `entries` (computed when it opens). */
export function ContextMenuArea({
  children,
  entries,
}: {
  children: ReactNode;
  entries: () => MenuEntry[];
}) {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={panel}>
          <Entries parts={ContextMenu} entries={entries()} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const usePointMenu = create<{ open: boolean; x: number; y: number; entries: MenuEntry[] }>(() => ({
  open: false,
  x: 0,
  y: 0,
  entries: [],
}));

/** Opens a menu at a point on screen (for right-clicks Radix can't wrap, like an editor gutter). */
export function showMenuAt(x: number, y: number, entries: MenuEntry[]) {
  // Closed first, so a second right-click moves the menu rather than keeping the old spot.
  usePointMenu.setState({ open: false });
  requestAnimationFrame(() => usePointMenu.setState({ open: true, x, y, entries }));
}

/** Where menus from `showMenuAt` open (mounted once, in App). */
export function PointMenuHost() {
  const { open, x, y, entries } = usePointMenu();
  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) usePointMenu.setState({ open: false });
      }}
      modal={false}
    >
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={panel}
          align="start"
          sideOffset={2}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <Entries parts={DropdownMenu} entries={entries} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
