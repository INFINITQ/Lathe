// Plugin commands for the palette: installing, restarting one, and picking a colour theme
// (Mono, or one a plugin brings).

import { backend } from '../lib/backend';
import { type Command, registerCommands } from '../services/commands';
import { getSetting } from '../services/settings';
import { showView } from '../workbench/layout';
import { quickPick } from '../workbench/quickinput/store';
import { installPlugin, restartPlugin } from './manager';
import { usePlugins } from './store';
import { pluginThemes } from './themes';

export async function pickColorTheme() {
  const current = getSetting('workbench.colorTheme');
  const items = [
    { id: '', label: 'Mono', description: 'Lathe’s own (light or dark, from the theme setting)' },
    ...pluginThemes().map((t) => ({
      id: t.key,
      label: t.label,
      description: `${t.base} · ${usePlugins.getState().installed.find((p) => p.manifest.id === t.plugin)?.manifest.name ?? t.plugin}`,
    })),
  ];
  const picked = await quickPick(items, {
    placeholder: 'Colour theme',
    active: Math.max(
      0,
      items.findIndex((i) => i.id === current),
    ),
  });
  if (!picked) return;
  await backend().settings.set('user', { 'workbench.colorTheme': picked.id || null });
}

export function registerPluginCommands() {
  const commands: Command[] = [
    {
      id: 'plugins.installFromFolder',
      title: 'Install a plugin from a folder…',
      category: 'Plugins',
      run: () => void installPlugin('folder'),
    },
    {
      id: 'plugins.installFromZip',
      title: 'Install a plugin from a .zip…',
      category: 'Plugins',
      run: () => void installPlugin('zip'),
    },
    {
      id: 'plugins.installFromGit',
      title: 'Install a plugin from a Git URL…',
      category: 'Plugins',
      run: () => void installPlugin('git'),
    },
    {
      id: 'plugins.restart',
      title: 'Restart a plugin…',
      category: 'Plugins',
      run: () =>
        void (async () => {
          const items = usePlugins
            .getState()
            .installed.filter((p) => p.enabled && p.manifest.main)
            .map((p) => ({ id: p.manifest.id, label: p.manifest.name }));
          const picked = await quickPick(items, { placeholder: 'Plugin to restart' });
          if (picked) restartPlugin(picked.id);
        })(),
    },
    {
      id: 'plugins.show',
      title: 'Show plugins',
      category: 'View',
      run: () => showView('plugins'),
    },
    {
      id: 'workbench.colorTheme',
      title: 'Colour theme…',
      category: 'Preferences',
      run: () => void pickColorTheme(),
    },
  ];
  registerCommands(commands);
}
