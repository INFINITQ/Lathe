// The Plugins view: what's installed (on or off, running or not, what each asks for), installing
// from a folder, a .zip or a Git URL, and removing.

import { FolderOpen, GitBranch, PackageOpen, Puzzle, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '../lib/cn';
import { DropdownMenuButton } from '../ui/Menu';
import { hostOf } from './host';
import {
  installPlugin,
  loadPlugins,
  restartPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from './manager';
import { PERMISSION_TEXT, type PluginStatus, usePlugins } from './store';

const iconButton =
  'grid size-6 shrink-0 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';

const STATUS: Record<PluginStatus, string> = {
  idle: 'Not started',
  starting: 'Starting',
  running: 'Running',
  crashed: 'Stopped',
  failed: "Didn't start",
};

export function PluginsView() {
  const installed = usePlugins((s) => s.installed);
  const status = usePlugins((s) => s.status);
  const errors = usePlugins((s) => s.errors);
  useEffect(() => {
    void loadPlugins();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-view="plugins">
      <header className="flex h-(--tabs-h) shrink-0 items-center gap-1 pr-1.5 pl-3">
        <h2 className="flex-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
          Plugins
        </h2>
        <DropdownMenuButton
          align="end"
          trigger={
            <button
              type="button"
              aria-label="Install a plugin"
              title="Install a plugin"
              className={iconButton}
            >
              <PackageOpen />
            </button>
          }
          entries={[
            { label: 'Install from a folder…', run: () => void installPlugin('folder') },
            { label: 'Install from a .zip…', run: () => void installPlugin('zip') },
            { label: 'Install from a Git URL…', run: () => void installPlugin('git') },
          ]}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!installed.length && (
          <div className="px-3 text-[12px] text-text-3">
            <p>No plugins yet.</p>
            <p className="mt-2">
              Plugins add commands, themes, snippets and language servers. Each runs in its own
              sandbox and can only do what it asked for when you installed it.
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              <button
                type="button"
                data-autofocus
                className="flex h-7 items-center justify-center gap-2 rounded-md border border-line text-[12px] text-text hover:bg-hover"
                onClick={() => void installPlugin('folder')}
              >
                <FolderOpen className="size-3.5" />
                Install from a folder…
              </button>
              <button
                type="button"
                className="flex h-7 items-center justify-center gap-2 rounded-md border border-line text-[12px] text-text hover:bg-hover"
                onClick={() => void installPlugin('git')}
              >
                <GitBranch className="size-3.5" />
                Install from a Git URL…
              </button>
            </div>
          </div>
        )}
        <ul aria-label="Installed plugins">
          {installed.map(({ manifest, enabled }) => {
            const state = status[manifest.id] ?? 'idle';
            const error = errors[manifest.id];
            const runs = !!manifest.main;
            return (
              <li
                key={manifest.id}
                aria-label={manifest.name}
                className="group border-b border-line px-3 py-2.5 last:border-b-0"
              >
                <div className="flex items-start gap-2">
                  <Puzzle
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      enabled ? 'text-accent-fg' : 'text-text-4',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-text">
                        {manifest.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-text-3">{manifest.version}</span>
                    </div>
                    {manifest.description && (
                      <p className="mt-0.5 text-[11.5px] text-text-2">{manifest.description}</p>
                    )}
                    <p
                      className="mt-1 text-[11px] text-text-3"
                      data-status={enabled ? state : 'off'}
                    >
                      {!enabled
                        ? 'Off'
                        : runs
                          ? STATUS[state]
                          : 'On (themes, snippets or settings only)'}
                      {manifest.publisher ? ` · ${manifest.publisher}` : ''}
                    </p>
                    {error && enabled && <p className="mt-0.5 text-[11px] text-danger">{error}</p>}
                    {manifest.permissions.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Permissions">
                        {manifest.permissions.map((p) => (
                          <li
                            key={p}
                            className="rounded-sm border border-line px-1.5 py-px text-[10.5px] text-text-3"
                            title={PERMISSION_TEXT[p]}
                          >
                            {PERMISSION_TEXT[p] ?? p}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {enabled && runs && hostOf(manifest.id) && (
                      <button
                        type="button"
                        aria-label={`Restart ${manifest.name}`}
                        title="Restart"
                        className={cn(iconButton, 'opacity-0 group-hover:opacity-100')}
                        onClick={() => restartPlugin(manifest.id)}
                      >
                        <RotateCcw />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${manifest.name}`}
                      title="Remove"
                      className={cn(iconButton, 'opacity-0 group-hover:opacity-100')}
                      onClick={() => void uninstallPlugin(manifest.id)}
                    >
                      <Trash2 />
                    </button>
                    <label
                      className="ml-1 flex items-center"
                      title={enabled ? 'Turn off' : 'Turn on'}
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`${manifest.name} on`}
                        checked={enabled}
                        onChange={(e) => void setPluginEnabled(manifest.id, e.target.checked)}
                        className="size-3.5 accent-(--accent-fg)"
                      />
                    </label>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
