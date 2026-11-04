// Source control actions that ask you something first: branch pickers, file history and
// local history, and opening the right comparison for a changed file.

import type { GitFileStatus } from '../../lib/backend';
import { backend, errorMessage } from '../../lib/backend';
import { basename } from '../../lib/paths';
import {
  type GitGroup,
  branches,
  deleteBranch,
  remote,
  switchBranch,
  useGit,
} from '../../services/git';
import { notify } from '../../services/notifications';
import { openDiff, openPath } from '../editors/store';
import { quickInputText, quickPick } from '../quickinput/store';

/** "3 days ago" (times in seconds or milliseconds since 1970). */
export function timeAgo(time: number): string {
  const ms = time < 1e12 ? time * 1000 : time;
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Click on a changed file: the comparison Git would show for it. */
export function openChange(file: GitFileStatus, group: GitGroup) {
  const name = basename(file.path);
  if (file.index === '?' && group === 'changes') {
    void openPath(file.path, { preview: true });
    return;
  }
  if (group === 'staged') {
    openDiff({
      path: file.path,
      left: { git: 'HEAD' },
      right: { git: file.index === 'D' ? '<deleted>' : 'index' },
      title: `${name} (HEAD ↔ staged)`,
    });
    return;
  }
  openDiff({
    path: file.path,
    left: { git: 'index' },
    right: file.worktree === 'D' ? { git: '<deleted>' } : 'working',
    title: `${name} (staged ↔ working tree)`,
  });
}

export async function createBranch(start?: string) {
  const name = await quickInputText({
    placeholder: start ? `New branch from ${start}` : 'New branch name',
    prompt: 'Press Enter to create the branch and switch to it.',
  });
  const clean = name?.trim().replace(/\s+/g, '-');
  if (clean) await switchBranch(clean, true, start);
}

/** The branch picker (the status bar's branch): switch, or create a new one. */
export async function showBranchPicker() {
  const list = await branches();
  const local = list.filter((b) => !b.remote);
  const remotes = list.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`)));
  const picked = await quickPick(
    [
      { id: 'create', label: 'Create a new branch…' },
      { id: 'create-from', label: 'Create a new branch from…' },
      ...local.map((b) => ({
        id: `local:${b.name}`,
        label: b.name,
        description: b.subject,
        hint: b.current ? 'current' : timeAgo(b.date),
        group: 'Branches',
      })),
      ...remotes.map((b) => ({
        id: `remote:${b.name}`,
        label: b.name,
        description: b.subject,
        hint: timeAgo(b.date),
        group: 'Remote branches',
      })),
    ],
    { placeholder: 'Switch to a branch', active: local.length ? 2 : 0 },
  );
  if (!picked) return;
  if (picked.id === 'create') return createBranch();
  if (picked.id === 'create-from') {
    const from = await quickPick(
      list.map((b) => ({ id: b.name, label: b.name, description: b.subject })),
      { placeholder: 'Create the new branch from…' },
    );
    if (from) await createBranch(from.id);
    return;
  }
  const kind = picked.id.slice(0, picked.id.indexOf(':'));
  const name = picked.id.slice(picked.id.indexOf(':') + 1);
  // A remote branch: Git makes a local branch that tracks it.
  const target = kind === 'remote' ? name.slice(name.indexOf('/') + 1) : name;
  if (local.find((b) => b.current)?.name === target) return;
  await switchBranch(target);
}

export async function pickBranchToDelete() {
  const local = (await branches()).filter((b) => !b.remote && !b.current);
  if (!local.length) {
    notify('info', 'There are no other branches to delete.');
    return;
  }
  const picked = await quickPick(
    local.map((b) => ({
      id: b.name,
      label: b.name,
      description: b.subject,
      hint: timeAgo(b.date),
    })),
    { placeholder: 'Delete a branch' },
  );
  if (picked) await deleteBranch(picked.id);
}

/** A file's commits; picking one shows what it changed in the file. */
export async function showFileHistory(path: string) {
  const root = useGit.getState().repo?.root;
  if (!root) {
    notify('info', "This file isn't in a Git repository.");
    return;
  }
  let commits;
  try {
    commits = await backend().git.log(root, path, 200);
  } catch (err) {
    notify('error', "Couldn't read the file's history.", { detail: errorMessage(err) });
    return;
  }
  if (!commits.length) {
    notify('info', `${basename(path)} has no commits yet.`);
    return;
  }
  const picked = await quickPick(
    commits.map((c) => ({
      id: c.hash,
      label: c.subject,
      description: `${c.short} · ${c.author}`,
      hint: timeAgo(c.date),
    })),
    { placeholder: `History of ${basename(path)}` },
  );
  if (!picked) return;
  const commit = commits.find((c) => c.hash === picked.id)!;
  openDiff({
    path,
    left: { git: `${commit.hash}^` },
    right: { git: commit.hash },
    title: `${basename(path)} (${commit.short}: ${commit.subject})`,
  });
}

/** Lathe's own copies of a file from each save; picking one compares it with the file now. */
export async function showLocalHistory(path: string) {
  const entries = await backend()
    .history.list(path)
    .catch(() => []);
  if (!entries.length) {
    notify(
      'info',
      `No earlier versions of ${basename(path)} yet. Lathe keeps one each time you save.`,
    );
    return;
  }
  const picked = await quickPick(
    entries.map((e) => ({
      id: e.id,
      label: new Date(e.time).toLocaleString(),
      description: `${Math.max(1, Math.round(e.size / 1024))} KB`,
      hint: timeAgo(e.time),
    })),
    { placeholder: `Saved versions of ${basename(path)}` },
  );
  if (!picked) return;
  openDiff({
    path,
    left: { history: picked.id },
    right: 'working',
    title: `${basename(path)} (saved ${timeAgo(Number(picked.id))} ↔ now)`,
  });
}

export async function syncWithRemote() {
  const repo = useGit.getState().repo;
  if (!repo) return;
  await remote(repo.upstream ? 'sync' : 'push');
}
