import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CornerDownLeft, Hash, Terminal } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { SymbolIcon } from '../../editor/SymbolIcon';
import { getActiveView } from '../../editor/active';
import { documentSymbols, flatSymbols } from '../../editor/symbols';
import { allDocuments } from '../../editor/documents';
import { backend } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { fuzzyFilter } from '../../lib/fuzzy';
import { basename, join, relative } from '../../lib/paths';
import { availableCommands, commandLabel, executeCommand } from '../../services/commands';
import { keyFor } from '../../services/keybindings';
import { type WorkspaceSymbol, findWorkspaceSymbols } from '../../services/workspaceSymbols';
import { useEditors, openPath } from '../editors/store';
import { fileIcon } from '../fileIcons';
import { useWorkspace } from '../workspaceStore';
import { type QuickItem, closeQuickInput, useQuickInput } from './store';

const VISIBLE = 12;

function Highlighted({ text, matches }: { text: string; matches?: number[] }) {
  if (!matches?.length) return <>{text}</>;
  const set = new Set(matches);
  const parts: ReactNode[] = [];
  let run = '';
  let hit = false;
  const flush = (i: number) => {
    if (!run) return;
    parts.push(
      hit ? (
        <span key={i} className="text-accent-fg">
          {run}
        </span>
      ) : (
        run
      ),
    );
    run = '';
  };
  [...text].forEach((ch, i) => {
    const isHit = set.has(i);
    if (isHit !== hit) {
      flush(i);
      hit = isHit;
    }
    run += ch;
  });
  flush(text.length);
  return <>{parts}</>;
}

/** Files of the open folder matching the query (Rust does the matching). */
function useFileItems(query: string, enabled: boolean): QuickItem[] {
  const root = useWorkspace((s) => s.root);
  const closed = useEditors((s) => s.closed);
  const [items, setItems] = useState<QuickItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    if (!root) {
      setItems([
        {
          id: 'open-folder',
          label: 'Open a folder to search its files',
          icon: <CornerDownLeft className="size-3.5" />,
          run: () => void executeCommand('file.openFolder'),
        },
      ]);
      return;
    }
    let stale = false;
    const fileItem = (path: string, matches: number[] | undefined, group?: string): QuickItem => {
      const full = join(root, path);
      const name = basename(path);
      const offset = path.length - name.length;
      const Icon = fileIcon(name);
      return {
        id: full,
        label: name,
        matches: matches?.filter((m) => m >= offset).map((m) => m - offset),
        description: path.slice(0, Math.max(0, offset - 1)),
        icon: <Icon className="size-3.5" strokeWidth={1.75} />,
        group,
        run: ({ side }) => void openPath(full, { group: side ? 'side' : undefined }),
      };
    };
    if (!query.trim()) {
      // Nothing typed: recently opened files first.
      const recent = [
        ...allDocuments()
          .map((d) => d.path)
          .filter((p): p is string => !!p),
        ...closed.map((c) => c.path),
      ];
      const seen = new Set<string>();
      const recentItems = recent
        .filter((p) => {
          const k = p.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 12)
        .map((p) => fileItem(relative(root, p), undefined, 'recently opened'));
      setItems(recentItems);
      if (recentItems.length) return;
    }
    const timer = setTimeout(() => {
      void backend()
        .workspace.findFiles(query, 60)
        .then((found) => {
          if (stale) return;
          const results = found.matches.map((m, i) =>
            fileItem(m.path, m.indices, i === 0 && !query.trim() ? 'files' : undefined),
          );
          setItems(
            results.length
              ? results
              : [{ id: 'none', label: found.complete ? 'No matching files' : 'Still indexing…' }],
          );
        })
        .catch(() => {});
    }, 25);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, enabled, root, closed]);
  return items;
}

/** "#": definitions across the folder, as the search engine finds them. */
function useWorkspaceSymbolItems(query: string, enabled: boolean): QuickItem[] {
  const root = useWorkspace((s) => s.root);
  const [found, setFound] = useState<{ query: string; symbols: WorkspaceSymbol[] }>({
    query: '',
    symbols: [],
  });
  useEffect(() => {
    if (!enabled || !root || !query.trim()) return;
    let stale = false;
    const timer = setTimeout(() => {
      findWorkspaceSymbols(query)
        .then((symbols) => {
          if (!stale) setFound({ query, symbols });
        })
        .catch(() => {});
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, enabled, root]);
  if (!enabled) return [];
  if (!root) return [{ id: 'none', label: 'Open a folder to search its symbols' }];
  if (!query.trim()) return [{ id: 'hint', label: 'Type the name of a class, function or type' }];
  if (found.query !== query) return [{ id: 'busy', label: 'Searching…' }];
  if (!found.symbols.length) return [{ id: 'none', label: 'No matching symbols' }];
  return fuzzyFilter(found.symbols, query, (s) => s.name)
    .slice(0, 200)
    .map(({ item, match }) => ({
      id: `${item.path}:${item.line}:${item.column}`,
      label: item.name,
      matches: match.indices,
      description: `${relative(root, item.path)}:${item.line}`,
      icon: <SymbolIcon kind={item.kind} />,
      run: ({ side }) =>
        void openPath(item.path, {
          group: side ? 'side' : undefined,
          selection: {
            line: item.line,
            column: item.column + 1,
            endLine: item.line,
            endColumn: item.column + 1 + item.name.length,
          },
        }),
    }));
}

/** "@": the active editor's symbols, from its syntax tree. */
function symbolItems(query: string): QuickItem[] {
  const view = getActiveView();
  if (!view) return [{ id: 'none', label: 'Open a text editor first, then go to a symbol' }];
  const symbols = flatSymbols(documentSymbols(view.state));
  if (!symbols.length) return [{ id: 'none', label: 'No symbols found in this file' }];
  return fuzzyFilter(symbols, query, (s) => s.symbol.name).map(({ item, match }) => ({
    id: String(item.symbol.from),
    label: item.symbol.name,
    matches: match.indices,
    description: item.container,
    icon: <SymbolIcon kind={item.symbol.kind} />,
    run: () => {
      view.dispatch({
        selection: EditorSelection.single(item.symbol.nameFrom, item.symbol.nameTo),
        effects: EditorView.scrollIntoView(item.symbol.nameFrom, { y: 'center' }),
      });
      view.focus();
    },
  }));
}

function commandItems(query: string): QuickItem[] {
  const commands = availableCommands().filter((c) => !c.hidden);
  return fuzzyFilter(commands, query, commandLabel).map(({ item, match }) => ({
    id: item.id,
    label: commandLabel(item),
    matches: match.indices,
    hint: keyFor(item.id),
    run: () => void executeCommand(item.id),
  }));
}

function lineItems(query: string): QuickItem[] {
  const view = getActiveView();
  if (!view) return [{ id: 'none', label: 'Open a text editor first, then go to a line' }];
  const lines = view.state.doc.lines;
  const match = /^\s*(\d+)?\s*(?:[:,]\s*(\d+))?\s*$/.exec(query);
  if (!match || !match[1]) {
    const current = view.state.doc.lineAt(view.state.selection.main.head).number;
    return [{ id: 'hint', label: `Type a line between 1 and ${lines} (you're on ${current})` }];
  }
  const line = Math.max(1, Math.min(Number(match[1]), lines));
  const column = match[2] ? Number(match[2]) : 1;
  return [
    {
      id: 'go',
      label: `Go to line ${line}${match[2] ? `, column ${column}` : ''}`,
      icon: <Hash className="size-3.5" />,
      run: () => {
        const target = view.state.doc.line(line);
        const pos = Math.min(target.from + column - 1, target.to);
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        view.focus();
      },
    },
  ];
}

const HELP: QuickItem[] = [
  {
    id: 'files',
    label: 'Go to file',
    hint: keyFor('quickOpen.files') ?? 'Ctrl+P',
    description: '(type a name)',
  },
  {
    id: '>',
    label: 'Run a command',
    hint: keyFor('quickOpen.commands') ?? 'Ctrl+Shift+P',
    description: '>',
  },
  {
    id: ':',
    label: 'Go to line',
    hint: keyFor('quickOpen.goToLine') ?? 'Ctrl+G',
    description: ':',
  },
  {
    id: '@',
    label: 'Go to a symbol in the editor',
    hint: keyFor('quickOpen.symbols') ?? 'Ctrl+Shift+O',
    description: '@',
  },
  {
    id: '#',
    label: 'Go to a symbol in the folder',
    hint: keyFor('quickOpen.workspaceSymbols') ?? 'Ctrl+T',
    description: '#',
  },
];

/** The quick input box, centred under the title bar. */
export function QuickInput() {
  const { open, mode, value, placeholder, pickItems, pickActive, prompt } = useQuickInput();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const prefix = mode === 'quickOpen' ? (/^[>:?@#]/.exec(value)?.[0] ?? '') : '';
  const query = mode === 'quickOpen' ? value.slice(prefix.length) : value;
  const files = useFileItems(query, open && mode === 'quickOpen' && prefix === '');
  const workspaceSymbols = useWorkspaceSymbolItems(
    query,
    open && mode === 'quickOpen' && prefix === '#',
  );

  const items: QuickItem[] = useMemo(() => {
    if (!open) return [];
    if (mode === 'input') return [{ id: 'prompt', label: prompt }];
    if (mode === 'pick') {
      return fuzzyFilter(pickItems, query, (i) => i.label).map(({ item, match }) => ({
        ...item,
        matches: match.indices,
      }));
    }
    if (prefix === '>') return commandItems(query);
    if (prefix === ':') return lineItems(query);
    if (prefix === '@') return symbolItems(query);
    if (prefix === '#') return workspaceSymbols;
    if (prefix === '?') {
      return HELP.map((h) => ({
        ...h,
        icon: <Terminal className="size-3.5" />,
        run: () => useQuickInput.setState({ value: h.id === 'files' ? '' : h.id }),
      }));
    }
    return files;
  }, [open, mode, pickItems, query, prefix, files, workspaceSymbols, prompt]);

  // Focus moves in the same render that opens the box, so the next key (Enter on the first
  // choice, say) can't still land in the editor behind it.
  useLayoutEffect(() => {
    if (!open) return;
    // Where to go back to: what had focus before the box (not the box itself, when only its
    // mode changed while open).
    const active = document.activeElement as HTMLElement | null;
    if (!active?.closest('[data-quick-input]')) restoreFocus.current = active;
    const focus = () => {
      const el = input.current;
      if (!el) return false;
      el.focus();
      // A suggested name is selected, so typing replaces it.
      if (useQuickInput.getState().mode === 'input') el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
      return true;
    };
    if (!focus()) requestAnimationFrame(focus);
  }, [open, mode]);

  useEffect(
    () => setActive(mode === 'pick' && !query ? pickActive : 0),
    [query, prefix, mode, pickActive],
  );

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const accept = (item: QuickItem | undefined, side = false) => {
    if (!item || (!item.run && mode === 'quickOpen')) return;
    const keepOpen = prefix === '?';
    if (!keepOpen) {
      closeQuickInput(mode === 'pick' ? item : null);
      // Give focus back first, so the command acts where you were.
      if (mode === 'quickOpen') restoreFocus.current?.focus?.();
    }
    item.run?.({ side });
  };

  return (
    <div
      className="fixed inset-0 z-40"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          closeQuickInput(null);
          restoreFocus.current?.focus?.();
        }
      }}
    >
      <div
        data-quick-input
        role="dialog"
        aria-label="Quick input"
        className="absolute top-[calc(var(--titlebar-h)+6px)] left-1/2 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-md border border-line-strong bg-overlay shadow-pop"
      >
        <input
          ref={input}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-input-list"
          aria-activedescendant={items[active] ? `quick-item-${active}` : undefined}
          spellCheck={false}
          className="h-9 w-full border-b border-line bg-transparent px-3 text-[13px] text-text outline-none placeholder:text-text-3"
          onChange={(e) => useQuickInput.setState({ value: e.target.value })}
          onKeyDown={(e) => {
            const page = VISIBLE - 1;
            if (e.key === 'ArrowDown') setActive((a) => Math.min(items.length - 1, a + 1));
            else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
            else if (e.key === 'PageDown') setActive((a) => Math.min(items.length - 1, a + page));
            else if (e.key === 'PageUp') setActive((a) => Math.max(0, a - page));
            else if (e.key === 'Enter' && mode === 'input') {
              closeQuickInput(null, value);
              restoreFocus.current?.focus?.();
            } else if (e.key === 'Enter') accept(items[active], e.ctrlKey);
            else if (e.key === 'Escape') {
              closeQuickInput(null);
              restoreFocus.current?.focus?.();
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <ul
          ref={list}
          id="quick-input-list"
          role="listbox"
          className="max-h-[calc(26px*12+8px)] overflow-y-auto py-1"
        >
          {items.map((item, i) => (
            <li key={`${item.id}-${i}`} role="presentation">
              {item.group && (
                <div className="px-3 pt-1.5 pb-0.5 text-[10.5px] tracking-wide text-text-3 uppercase">
                  {item.group}
                </div>
              )}
              <div
                id={`quick-item-${i}`}
                role="option"
                aria-selected={i === active}
                data-index={i}
                className={cn(
                  'mx-1 flex h-[26px] cursor-default items-center gap-2 rounded-sm px-2 text-[12.5px]',
                  i === active ? 'bg-active text-text' : 'text-text-2',
                  !item.run && mode === 'quickOpen' && 'text-text-3',
                )}
                onPointerMove={() => setActive(i)}
                onClick={() => accept(item)}
              >
                {item.icon && <span className="shrink-0 text-text-3">{item.icon}</span>}
                <span className="shrink-0 truncate">
                  <Highlighted text={item.label} matches={item.matches} />
                </span>
                {item.description && (
                  <span className="min-w-0 truncate text-[11.5px] text-text-3">
                    {item.description}
                  </span>
                )}
                <span className="flex-1" />
                {item.hint && <span className="shrink-0 text-[11px] text-text-3">{item.hint}</span>}
              </div>
            </li>
          ))}
          {items.length === 0 && (
            <li className="px-3 py-1.5 text-[12px] text-text-3">
              {prefix === '>' ? 'No matching commands' : 'No results'}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
