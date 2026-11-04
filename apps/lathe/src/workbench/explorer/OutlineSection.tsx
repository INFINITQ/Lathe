import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { SymbolIcon } from '../../editor/SymbolIcon';
import { revealSymbol, useOutline } from '../../editor/outline';
import { type DocSymbol, symbolPath } from '../../editor/symbols';
import { cn } from '../../lib/cn';
import { useLayout } from '../layout';

const ROW = 22;

interface Row {
  key: string;
  symbol: DocSymbol;
  depth: number;
}

function rowsOf(symbols: DocSymbol[], collapsed: Set<string>, depth = 0, out: Row[] = []): Row[] {
  for (const symbol of symbols) {
    const key = `${symbol.from}:${symbol.name}`;
    out.push({ key, symbol, depth });
    if (!collapsed.has(key)) rowsOf(symbol.children, collapsed, depth + 1, out);
  }
  return out;
}

/** The Explorer's Outline: the active editor's symbols, following the cursor. */
export function OutlineSection() {
  const open = useLayout((s) => s.outlineOpen);
  return (
    <section
      aria-label="Outline"
      className={cn('flex shrink-0 flex-col border-t border-line', open && 'h-[38%] min-h-32')}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex h-6 shrink-0 items-center gap-1 px-1.5 text-left text-[11px] font-medium tracking-wide text-text-3 uppercase hover:text-text-2"
        onClick={() => useLayout.setState({ outlineOpen: !open })}
      >
        <ChevronRight
          className={cn('size-3.5 transition-transform duration-(--dur)', open && 'rotate-90')}
        />
        Outline
      </button>
      {open && <OutlineTree />}
    </section>
  );
}

function OutlineTree() {
  const { view, symbols, cursor } = useOutline();
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [focused, setFocused] = useState<string | null>(null);
  const rows = useMemo(() => rowsOf(symbols, collapsed), [symbols, collapsed]);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  });
  // The innermost symbol around the cursor is highlighted and kept in view.
  const here = symbolPath(symbols, cursor).at(-1);
  const hereIndex = here ? rows.findIndex((r) => r.symbol === here) : -1;
  useEffect(() => {
    if (hereIndex >= 0) virtualizer.scrollToIndex(hereIndex, { align: 'auto' });
  }, [hereIndex, virtualizer]);

  if (!view) {
    return <p className="px-3 py-1 text-[12px] text-text-3">Open a file to see its outline.</p>;
  }
  if (!symbols.length) {
    return <p className="px-3 py-1 text-[12px] text-text-3">No symbols found in this file.</p>;
  }

  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const focusIndex = rows.findIndex((r) => r.key === focused);
  const onKeyDown = (event: KeyboardEvent) => {
    const row = rows[focusIndex];
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) setFocused(next.key);
    };
    switch (event.key) {
      case 'ArrowDown':
        move(focusIndex + 1);
        break;
      case 'ArrowUp':
        move(focusIndex - 1);
        break;
      case 'ArrowRight':
        if (row && collapsed.has(row.key)) toggle(row.key);
        break;
      case 'ArrowLeft':
        if (row?.symbol.children.length && !collapsed.has(row.key)) toggle(row.key);
        break;
      case 'Enter':
        if (row) revealSymbol(view, row.symbol);
        break;
      case ' ':
        if (row) revealSymbol(view, row.symbol, false);
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
      aria-label="Symbols"
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto pb-2 outline-none"
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (!focused && rows[0]) setFocused(rows[0].key);
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const { symbol } = row;
          const parent = symbol.children.length > 0;
          return (
            <div
              key={row.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={parent ? !collapsed.has(row.key) : undefined}
              aria-selected={focused === row.key}
              className={cn(
                'absolute inset-x-0 flex cursor-default items-center gap-1.5 pr-2 text-[12.5px] whitespace-nowrap text-text-2 hover:bg-hover hover:text-text',
                symbol === here && 'text-text',
                focused === row.key && 'bg-active',
              )}
              style={{
                top: 0,
                height: ROW,
                transform: `translateY(${item.start}px)`,
                paddingLeft: 8 + row.depth * 12,
              }}
              onClick={() => {
                setFocused(row.key);
                revealSymbol(view, symbol, false);
              }}
              onDoubleClick={() => revealSymbol(view, symbol)}
            >
              <span
                className="grid size-3.5 shrink-0 place-items-center text-text-3"
                onClick={(e) => {
                  if (!parent) return;
                  e.stopPropagation();
                  toggle(row.key);
                }}
              >
                {parent && (
                  <ChevronRight
                    className={cn(
                      'size-3.5 transition-transform duration-(--dur)',
                      !collapsed.has(row.key) && 'rotate-90',
                    )}
                  />
                )}
              </span>
              <SymbolIcon kind={symbol.kind} />
              <span className="truncate">{symbol.name}</span>
              {symbol === here && (
                <span
                  className="ml-auto size-1.5 shrink-0 rounded-full bg-accent-fg"
                  aria-label="Cursor is here"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
