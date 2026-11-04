import { FilePlus, FolderOpen, X } from 'lucide-react';
import { executeCommand } from '../../services/commands';
import { keyFor } from '../../services/keybindings';
import { basename, dirname } from '../../lib/paths';
import { useWorkspace } from '../workspaceStore';
import { backend } from '../../lib/backend';

/** The start page: open something, pick a recent folder, learn three shortcuts. */
export function Welcome() {
  const recent = useWorkspace((s) => s.recent);
  const root = useWorkspace((s) => s.root);
  const shortcuts: [string, string][] = [
    ['Search files', keyFor('quickOpen.files') ?? 'Ctrl+P'],
    ['Run a command', keyFor('quickOpen.commands') ?? 'Ctrl+Shift+P'],
    ['Toggle terminal', keyFor('view.toggleTerminal') ?? 'Ctrl+`'],
    ['Toggle sidebar', keyFor('view.toggleSidebar') ?? 'Ctrl+B'],
  ];
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-8">
      <div className="w-full max-w-[520px]">
        <div className="mb-10 flex items-center gap-3">
          <svg viewBox="0 0 1024 1024" className="size-9" aria-hidden="true">
            <path
              d="M368 280v432h304"
              fill="none"
              stroke="var(--accent-fg)"
              strokeWidth="96"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="672" cy="352" r="64" fill="var(--accent-fg)" />
          </svg>
          <div>
            <h1 className="text-[20px] font-medium tracking-tight text-text">Lathe</h1>
            <p className="text-[12px] text-text-3">{root ? basename(root) : 'Shape some code.'}</p>
          </div>
        </div>

        <h2 className="mb-2 text-[11px] font-medium tracking-wide text-text-3 uppercase">Start</h2>
        <div className="mb-8 flex flex-col gap-0.5">
          <WelcomeAction
            icon={<FolderOpen className="size-4" />}
            label="Open folder…"
            shortcut={keyFor('file.openFolder')}
            onClick={() => void executeCommand('file.openFolder')}
          />
          <WelcomeAction
            icon={<FilePlus className="size-4" />}
            label="New file"
            shortcut={keyFor('file.new')}
            onClick={() => void executeCommand('file.new')}
          />
        </div>

        {recent.length > 0 && (
          <>
            <h2 className="mb-2 text-[11px] font-medium tracking-wide text-text-3 uppercase">
              Recent
            </h2>
            <ul className="mb-8 flex flex-col gap-0.5">
              {recent.slice(0, 8).map((path) => (
                <li key={path} className="group flex items-center">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-baseline gap-3 rounded-sm px-2 py-1 text-left hover:bg-hover"
                    onClick={() => void executeCommand('workspace.open', path)}
                  >
                    <span className="shrink-0 text-[12.5px] text-text">{basename(path)}</span>
                    <span className="truncate text-[11px] text-text-3">{dirname(path)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${basename(path)} from recent folders`}
                    className="ml-1 grid size-6 place-items-center rounded-sm text-text-4 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-text"
                    onClick={async () => {
                      const next = await backend().session.removeRecent(path);
                      useWorkspace.setState({ recent: next });
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <h2 className="mb-2 text-[11px] font-medium tracking-wide text-text-3 uppercase">Keys</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[12px]">
          {shortcuts.map(([label, key]) => (
            <div key={label} className="contents">
              <dt className="text-text-2">{label}</dt>
              <dd className="text-right">
                <kbd className="rounded-sm border border-line bg-raised px-1.5 py-px font-sans text-[11px] text-text-2">
                  {key}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function WelcomeAction({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-sm px-2 py-1.5 text-left text-[12.5px] text-text hover:bg-hover"
      onClick={onClick}
    >
      <span className="text-accent-fg">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[11px] text-text-3">{shortcut}</span>}
    </button>
  );
}
