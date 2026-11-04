// The open folder. Opening one starts Rust's watcher and file index; changes on disk fan out
// to the explorer and to open documents.

import { create } from 'zustand';
import { handleDiskChanges } from '../editor/documents';
import { type FsChange, backend, errorMessage } from '../lib/backend';
import { basename } from '../lib/paths';
import { notify } from '../services/notifications';
import { applySettings, useSettings } from '../services/settings';
import { closeAllEditors } from './editors/store';

interface WorkspaceState {
  root: string | null;
  name: string | null;
  recent: string[];
}

export const useWorkspace = create<WorkspaceState>(() => ({
  root: null,
  name: null,
  recent: backend().boot().recent,
}));

const listeners = new Set<(changes: FsChange[]) => void>();

/** Calls `listener` with every batch of changes on disk in the open folder. */
export function onDiskChanges(listener: (changes: FsChange[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function userSnapshot() {
  const { user, userPath, errors } = useSettings.getState();
  return { path: userPath, values: user, error: errors[0] ?? null };
}

/**
 * Opens a folder. Switching from another folder closes its editors first (asking about
 * unsaved ones); resolves false if that was cancelled or the folder couldn't be opened.
 */
export async function openFolder(path: string, options: { keepEditors?: boolean } = {}) {
  const { root } = useWorkspace.getState();
  if (root && !options.keepEditors && !(await closeAllEditors())) return false;
  try {
    const opened = await backend().workspace.open(path, (changes) => {
      handleDiskChanges(changes);
      listeners.forEach((l) => l(changes));
    });
    useWorkspace.setState({ root: opened.root, name: opened.name, recent: opened.recent });
    applySettings({ user: userSnapshot(), workspace: opened.settings });
    void backend().window.setTitle(`${opened.name} — Lathe`);
    return true;
  } catch (err) {
    notify('error', `Couldn't open ${basename(path)}.`, { detail: errorMessage(err) });
    return false;
  }
}

export async function closeFolder() {
  if (!(await closeAllEditors())) return;
  await backend().workspace.close();
  useWorkspace.setState({ root: null, name: null });
  applySettings({ user: userSnapshot(), workspace: null });
  void backend().window.setTitle('Lathe');
}

export async function pickAndOpenFolder() {
  const path = await backend().dialogs.pickFolder();
  if (path) await openFolder(path);
}
