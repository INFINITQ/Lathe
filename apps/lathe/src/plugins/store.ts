// What Lathe knows about plugins: the installed ones, how each is doing, and the status bar
// items they show.

import { create } from 'zustand';
import type { InstalledPlugin } from '../lib/backend';

export type PluginStatus = 'idle' | 'starting' | 'running' | 'crashed' | 'failed';

export interface PluginStatusItem {
  /** "<plugin>:<item>". */
  key: string;
  plugin: string;
  text: string;
  tooltip?: string;
  command?: string;
  alignment: 'left' | 'right';
  visible: boolean;
}

interface PluginsState {
  installed: InstalledPlugin[];
  status: Record<string, PluginStatus>;
  /** Why a plugin isn't running, when it isn't. */
  errors: Record<string, string>;
  statusItems: PluginStatusItem[];
}

export const usePlugins = create<PluginsState>(() => ({
  installed: [],
  status: {},
  errors: {},
  statusItems: [],
}));

export function setPluginStatus(id: string, status: PluginStatus, error?: string) {
  usePlugins.setState((s) => {
    const errors = { ...s.errors };
    if (error) errors[id] = error;
    else if (status === 'running' || status === 'starting') delete errors[id];
    return { status: { ...s.status, [id]: status }, errors };
  });
}

export function setStatusItem(item: PluginStatusItem) {
  usePlugins.setState((s) => {
    const others = s.statusItems.filter((i) => i.key !== item.key);
    return { statusItems: [...others, item] };
  });
}

export function removeStatusItems(plugin: string, key?: string) {
  usePlugins.setState((s) => ({
    statusItems: s.statusItems.filter((i) => (key ? i.key !== key : i.plugin !== plugin)),
  }));
}

export const PERMISSION_TEXT: Record<string, string> = {
  'workspace.read': 'Read files in the open folder',
  'workspace.write': 'Change files in the open folder',
  terminal: 'Run commands in a terminal',
  network: 'Connect to the internet',
};
