import { Bug, Files, GitBranch, type LucideIcon, Puzzle, Search, Settings } from 'lucide-react';
import { cn } from '../lib/cn';
import { executeCommand } from '../services/commands';
import { keyFor } from '../services/keybindings';
import { type Accent, getSetting, updateSetting, useSetting } from '../services/settings';
import { DropdownMenuButton } from '../ui/Menu';
import { type ViewId, showView, useLayout } from './layout';

const VIEWS: { id: ViewId; icon: LucideIcon; label: string; command: string }[] = [
  { id: 'explorer', icon: Files, label: 'Explorer', command: 'view.explorer' },
  { id: 'search', icon: Search, label: 'Search', command: 'view.search' },
  { id: 'scm', icon: GitBranch, label: 'Source control', command: 'view.scm' },
  { id: 'debug', icon: Bug, label: 'Run and debug', command: 'view.debug' },
  { id: 'plugins', icon: Puzzle, label: 'Plugins', command: 'view.plugins' },
];

const ACCENTS: { id: Accent; label: string }[] = [
  { id: 'lime', label: 'Lime' },
  { id: 'mint', label: 'Mint' },
  { id: 'sky', label: 'Sky' },
  { id: 'violet', label: 'Violet' },
  { id: 'rose', label: 'Rose' },
  { id: 'amber', label: 'Amber' },
];

/** The slim column of view icons on the left, with the settings menu at the bottom. */
export function ActivityRail() {
  const view = useLayout((s) => s.view);
  const sidebarVisible = useLayout((s) => s.sidebarVisible);
  const theme = useSetting('workbench.theme');
  const accent = useSetting('workbench.accent');
  return (
    <nav
      className="flex w-(--rail-w) shrink-0 flex-col items-center gap-1 border-r border-line bg-bg py-2"
      aria-label="Views"
    >
      {VIEWS.map(({ id, icon: Icon, label, command }) => {
        const active = sidebarVisible && view === id;
        const shortcut = keyFor(command);
        return (
          <button
            key={id}
            type="button"
            aria-label={shortcut ? `${label} (${shortcut})` : label}
            title={shortcut ? `${label} (${shortcut})` : label}
            aria-pressed={active}
            onClick={() => showView(id, true)}
            className={cn(
              'relative grid size-9 place-items-center rounded-md transition-colors duration-(--dur)',
              active ? 'text-text' : 'text-text-3 hover:text-text',
            )}
          >
            {active && (
              <span
                className="absolute inset-y-2 left-[-4px] w-0.5 rounded-full bg-accent-fg"
                aria-hidden="true"
              />
            )}
            <Icon className="size-[18px]" strokeWidth={1.6} />
          </button>
        );
      })}
      <div className="flex-1" />
      <DropdownMenuButton
        align="start"
        trigger={
          <button
            type="button"
            aria-label="Manage"
            title="Manage"
            className="grid size-9 place-items-center rounded-md text-text-3 transition-colors duration-(--dur) hover:text-text"
          >
            <Settings className="size-[18px]" strokeWidth={1.6} />
          </button>
        }
        entries={[
          {
            label: 'Command palette…',
            shortcut: keyFor('quickOpen.commands'),
            run: () => void executeCommand('quickOpen.commands'),
          },
          {
            label: 'Settings (JSON)',
            shortcut: keyFor('preferences.openSettings'),
            run: () => void executeCommand('preferences.openSettings'),
          },
          'separator',
          {
            label: 'Theme',
            items: (['system', 'dark', 'light'] as const).map((t) => ({
              label: t === 'system' ? 'Follow Windows' : t === 'dark' ? 'Dark' : 'Light',
              checked: theme === t,
              run: () => void updateSetting('workbench.theme', t),
            })),
          },
          {
            label: 'Accent',
            items: ACCENTS.map((a) => ({
              label: a.label,
              checked: accent === a.id,
              run: () => void updateSetting('workbench.accent', a.id),
            })),
          },
          'separator',
          {
            label: getSetting('editor.minimap.enabled') ? 'Hide minimap' : 'Show minimap',
            run: () => void executeCommand('view.toggleMinimap'),
          },
          {
            label: 'Zen mode',
            shortcut: keyFor('view.toggleZen'),
            run: () => void executeCommand('view.toggleZen'),
          },
        ]}
      />
    </nav>
  );
}
