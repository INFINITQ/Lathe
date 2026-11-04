import { Plus, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type TerminalProfile, backend } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { DropdownMenuButton } from '../../ui/Menu';
import { TerminalView } from './TerminalView';
import { closeTerminal, newTerminal, setActiveTerminal, useTerminals } from './store';

/** The terminal panel: the active terminal, and a list of them when there's more than one. */
export function TerminalPanel() {
  const terminals = useTerminals((s) => s.terminals);
  const active = useTerminals((s) => s.active);
  if (!terminals.length) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-text-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-sm px-3 py-1.5 hover:bg-hover hover:text-text"
          onClick={() => void newTerminal()}
        >
          <SquareTerminal className="size-4" />
          New terminal
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1 pl-2">
        {terminals.map((t) => (
          <div key={t.id} className={cn('absolute inset-0 pl-2', t.id !== active && 'invisible')}>
            <TerminalView info={t} active={t.id === active} />
          </div>
        ))}
      </div>
      {terminals.length > 1 && (
        <ul
          className="w-44 shrink-0 overflow-y-auto border-l border-line py-1"
          aria-label="Terminals"
        >
          {terminals.map((t) => (
            <li key={t.id}>
              <div
                className={cn(
                  'group flex h-6 cursor-default items-center gap-1.5 pr-1 pl-2 text-[12px]',
                  t.id === active ? 'bg-active text-text' : 'text-text-2 hover:bg-hover',
                )}
                onClick={() => setActiveTerminal(t.id)}
              >
                <SquareTerminal className="size-3.5 shrink-0 text-text-3" />
                <span className={cn('flex-1 truncate', !t.running && 'text-text-3')}>
                  {t.title}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  className="grid size-5 place-items-center rounded-sm text-text-3 opacity-0 group-hover:opacity-100 hover:text-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTerminal(t.id);
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** New terminal (with a choice of shells) and kill, for the panel's header. */
export function TerminalActions() {
  const active = useTerminals((s) => s.active);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  useEffect(() => {
    void backend()
      .terminal.profiles()
      .then(setProfiles)
      .catch(() => {});
  }, []);
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal (Ctrl+Shift+`)"
        className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
        onClick={() => void newTerminal()}
      >
        <Plus className="size-3.5" />
      </button>
      {profiles.length > 1 && (
        <DropdownMenuButton
          align="end"
          trigger={
            <button
              type="button"
              aria-label="Choose a shell"
              className="grid size-6 place-items-center rounded-sm text-[10px] text-text-3 hover:bg-hover hover:text-text"
            >
              ▾
            </button>
          }
          entries={profiles.map((p) => ({ label: p.title, run: () => void newTerminal(p.id) }))}
        />
      )}
      {active && (
        <button
          type="button"
          aria-label="Kill terminal"
          title="Kill terminal"
          className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
          onClick={() => void closeTerminal(active)}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
