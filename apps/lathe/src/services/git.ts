// Source control state for the open folder: the repository's status (refreshed when files or
// .git change, after saves and after Git operations), and the operations the Source control
// view, the gutter and the status bar use. Git itself runs in Rust (lathe_core::git).

import { create } from 'zustand';
import { documentForPath, saveDocument } from '../editor/documents';
import {
  type GitBlob,
  type GitBranch,
  type GitFileStatus,
  type GitRepoStatus,
  backend,
  errorKind,
  errorMessage,
} from '../lib/backend';
import { debounce } from '../lib/events';
import { basename, isUnder, pathKey } from '../lib/paths';
import { useWorkspace } from '../workbench/workspaceStore';
import { ask } from './dialogs';
import { notify } from './notifications';
import { appendOutput } from './output';

export type GitGroup = 'conflicts' | 'staged' | 'changes';

export interface GitState {
  /** The repository holding the open folder, or null (none, or Git isn't installed). */
  repo: GitRepoStatus | null;
  /** True until the first status of the folder is known. */
  loading: boolean;
  /** The operation running now ("Pushing…"), for the view and status bar. */
  busy: string | null;
  message: string;
  amend: boolean;
  /** Bumped whenever the index or HEAD may have changed (gutters reload their base). */
  revision: number;
}

export const useGit = create<GitState>(() => ({
  repo: null,
  loading: false,
  busy: null,
  message: '',
  amend: false,
  revision: 0,
}));

const OUTPUT = 'Git';

function log(text: string) {
  if (text.trim()) appendOutput(OUTPUT, `${text.trim()}\n`);
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Reads the status again (calls that arrive while one runs are folded into one more). */
export async function refreshGit(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      const root = useWorkspace.getState().root;
      if (!root) {
        useGit.setState({ repo: null, loading: false });
        continue;
      }
      try {
        const repo = await backend().git.status(root);
        const previous = useGit.getState().repo;
        const changed =
          !previous ||
          previous.head !== repo?.head ||
          JSON.stringify(previous.files) !== JSON.stringify(repo?.files);
        useGit.setState((s) => ({
          repo,
          loading: false,
          revision: changed ? s.revision + 1 : s.revision,
        }));
      } catch (err) {
        useGit.setState({ loading: false });
        log(errorMessage(err));
      }
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export const refreshGitSoon = debounce(() => void refreshGit(), 250);

/** The groups a file is in: staged, changed (a file can be both), or a conflict. */
export function groupsOf(file: GitFileStatus): GitGroup[] {
  if (file.conflict) return ['conflicts'];
  const groups: GitGroup[] = [];
  if (file.index !== '.' && file.index !== '?') groups.push('staged');
  if (file.worktree !== '.' || file.index === '?') groups.push('changes');
  return groups;
}

/** The letter shown for a file in a group (U for untracked, as in VS Code). */
export function letterOf(file: GitFileStatus, group: GitGroup): string {
  if (group === 'conflicts') return '!';
  if (file.index === '?') return 'U';
  const letter = group === 'staged' ? file.index : file.worktree;
  return letter === '.' ? 'M' : letter;
}

/** Explorer decorations by path key: each file's strongest status. */
export function decorationsOf(repo: GitRepoStatus | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!repo) return map;
  for (const file of repo.files) {
    const letter = file.conflict
      ? '!'
      : file.index === '?'
        ? 'U'
        : file.worktree === 'D' || file.index === 'D'
          ? 'D'
          : file.index === 'A'
            ? 'A'
            : 'M';
    map.set(pathKey(file.path), letter);
  }
  return map;
}

async function withBusy<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  useGit.setState({ busy: label });
  try {
    return await run();
  } catch (err) {
    const message = errorMessage(err);
    log(message);
    notify('error', `${label.replace(/…$/, '')} didn't work.`, {
      detail: message,
      actions: [{ label: 'Show Git output', run: () => void showGitOutput() }],
    });
    return null;
  } finally {
    useGit.setState({ busy: null });
    await refreshGit();
  }
}

export async function showGitOutput() {
  const { useOutput } = await import('./output');
  const { showPanel } = await import('../workbench/layout');
  useOutput.setState({ active: OUTPUT });
  showPanel('output');
}

function repoRoot(): string | null {
  return useGit.getState().repo?.root ?? null;
}

/** Saves open files with unsaved changes first, so Git sees what you see. */
async function saveFirst(paths: string[]) {
  for (const path of paths) {
    const doc = documentForPath(path);
    if (doc?.dirty) await saveDocument(doc);
  }
}

export async function stage(paths: string[]) {
  const root = repoRoot();
  if (!root || !paths.length) return;
  await saveFirst(paths);
  await withBusy('Staging…', () => backend().git.stage(root, paths));
}

export async function unstage(paths: string[]) {
  const repo = useGit.getState().repo;
  if (!repo || !paths.length) return;
  await withBusy('Unstaging…', () => backend().git.unstage(repo.root, paths, !!repo.head));
}

/** Throws away changes (after asking); new files go to the Recycle Bin. */
export async function discard(files: GitFileStatus[]) {
  const root = repoRoot();
  if (!root || !files.length) return;
  const untracked = files.filter((f) => f.index === '?');
  const tracked = files.filter((f) => f.index !== '?');
  const what = files.length === 1 ? basename(files[0]!.path) : `${files.length} files`;
  const answer = await ask({
    title: `Discard the changes in ${what}?`,
    message: untracked.length
      ? 'Changes to tracked files are lost; new files go to the Recycle Bin.'
      : "The changes are lost, and Ctrl+Z can't bring them back.",
    buttons: [
      { id: 'discard', label: 'Discard', danger: true },
      { id: 'cancel', label: 'Cancel', primary: true },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'discard') return;
  await withBusy('Discarding…', async () => {
    if (tracked.length)
      await backend().git.discard(
        root,
        tracked.map((f) => f.path),
      );
    if (untracked.length)
      await backend().fs.delete(
        untracked.map((f) => f.path),
        true,
      );
  });
}

export async function commit(options: { amend?: boolean } = {}) {
  const state = useGit.getState();
  const repo = state.repo;
  if (!repo) return;
  const amend = options.amend ?? state.amend;
  const message = state.message.trim();
  if (!message && !amend) {
    notify('info', 'Write a commit message first.');
    return;
  }
  const staged = repo.files.some((f) => groupsOf(f).includes('staged'));
  if (!staged && !amend) {
    const changes = repo.files.filter((f) => groupsOf(f).includes('changes'));
    if (!changes.length) {
      notify('info', 'There are no changes to commit.');
      return;
    }
    const answer = await ask({
      title: 'Nothing is staged. Commit all your changes?',
      message: `This stages and commits ${changes.length} ${changes.length === 1 ? 'file' : 'files'}.`,
      buttons: [
        { id: 'all', label: 'Stage all and commit', primary: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'all') return;
    await saveFirst(changes.map((c) => c.path));
    await backend().git.stage(
      repo.root,
      changes.map((c) => c.path),
    );
  }
  const identity = await backend().git.identity(repo.root);
  if (!identity.name || !identity.email) {
    notify('warning', 'Git needs your name and email before it can commit.', {
      detail:
        'Run these in a terminal:\ngit config --global user.name "Your Name"\ngit config --global user.email you@example.com',
    });
    return;
  }
  const done = await withBusy('Committing…', () =>
    backend().git.commit(repo.root, message, amend, false),
  );
  if (done !== null) {
    log(done);
    useGit.setState({ message: '', amend: false });
  }
}

export async function branches(): Promise<GitBranch[]> {
  const root = repoRoot();
  if (!root) return [];
  return backend()
    .git.branches(root)
    .catch(() => []);
}

export async function switchBranch(name: string, create = false, start?: string) {
  const root = repoRoot();
  if (!root) return;
  await withBusy(create ? `Creating ${name}…` : `Switching to ${name}…`, () =>
    backend().git.switchBranch(root, name, create, start),
  );
}

export async function deleteBranch(name: string) {
  const root = repoRoot();
  if (!root) return;
  try {
    await backend().git.deleteBranch(root, name, false);
  } catch (err) {
    if (errorKind(err) !== 'gitFailed') {
      notify('error', `Couldn't delete ${name}.`, { detail: errorMessage(err) });
      return;
    }
    const answer = await ask({
      title: `${name} isn't merged. Delete it anyway?`,
      message: 'Commits that are on no other branch will be lost.',
      buttons: [
        { id: 'delete', label: 'Delete', danger: true },
        { id: 'cancel', label: 'Cancel', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer === 'delete') {
      await backend()
        .git.deleteBranch(root, name, true)
        .catch((e: unknown) =>
          notify('error', `Couldn't delete ${name}.`, { detail: errorMessage(e) }),
        );
    }
  } finally {
    await refreshGit();
  }
}

export type RemoteAction = 'fetch' | 'pull' | 'push' | 'sync';

export async function remote(action: RemoteAction) {
  const repo = useGit.getState().repo;
  if (!repo) return;
  const run = async (name: 'fetch' | 'pull' | 'push', options: string[]) => {
    log(`> git ${name} ${options.join(' ')}`);
    log(await backend().git.remote(repo.root, name, options));
  };
  const labels = { fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…', sync: 'Syncing…' };
  await withBusy(labels[action], async () => {
    if (action === 'fetch') await run('fetch', ['--all', '--prune']);
    if (action === 'pull' || action === 'sync') await run('pull', ['--ff-only']);
    if (action === 'push' || action === 'sync') {
      await run('push', repo.upstream ? [] : ['--set-upstream', 'origin', 'HEAD']);
    }
  });
}

export async function stash(action: 'push' | 'pop') {
  const root = repoRoot();
  if (!root) return;
  const output = await withBusy(action === 'push' ? 'Stashing…' : 'Restoring the stash…', () =>
    backend().git.stash(root, action),
  );
  if (output) log(output);
}

export async function initRepository() {
  const root = useWorkspace.getState().root;
  if (!root) return;
  await withBusy('Creating the repository…', () => backend().git.init(root));
}

/** What a file is compared with: the index (staged) or HEAD. Null when it's new there. */
export async function baseOf(path: string, rev: 'index' | 'HEAD'): Promise<GitBlob | null> {
  const repo = useGit.getState().repo;
  if (!repo || !isUnder(path, repo.root)) return null;
  if (rev === 'HEAD' && !repo.head) return null;
  return backend()
    .git.show(repo.root, rev === 'index' ? '' : 'HEAD', path)
    .catch(() => null);
}

/** Puts exact text in the index for one file (staging or unstaging a single hunk). */
export async function setIndex(path: string, text: string, format: GitBlob['format']) {
  const root = repoRoot();
  if (!root) return;
  await withBusy('Staging…', () => backend().git.setIndex(root, path, text, format));
}

/** The status of one file, if it has changes. */
export function statusOf(path: string): GitFileStatus | null {
  const key = pathKey(path);
  return useGit.getState().repo?.files.find((f) => pathKey(f.path) === key) ?? null;
}
