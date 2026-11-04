// The explorer's tree: folders load when you open them and reload when the watcher says
// something inside changed. Paths are keyed case-insensitively, as Windows compares them.

import { create } from 'zustand';
import { movedOnDisk } from '../../editor/documents';
import { type DirEntry, type FsChange, backend, errorMessage } from '../../lib/backend';
import { basename, dirname, isUnder, join, pathKey } from '../../lib/paths';
import { ask } from '../../services/dialogs';
import { notify } from '../../services/notifications';
import { getSetting } from '../../services/settings';

export interface TreeNode {
  path: string;
  name: string;
  dir: boolean;
  link: boolean;
  hidden: boolean;
}

export interface Row {
  key: string;
  node: TreeNode;
  depth: number;
  /** An inline input row (new file or folder) rather than a real entry. */
  input?: 'newFile' | 'newFolder';
}

interface TreeState {
  root: string | null;
  nodes: Record<string, TreeNode>;
  /** Loaded folders' children (keys), already sorted folders-first. */
  children: Record<string, string[]>;
  expanded: Record<string, true>;
  selected: string[];
  anchor: string | null;
  focused: string | null;
  renaming: string | null;
  creating: { parent: string; dir: boolean } | null;
  clipboard: { paths: string[]; cut: boolean } | null;
}

export const useTree = create<TreeState>(() => ({
  root: null,
  nodes: {},
  children: {},
  expanded: {},
  selected: [],
  anchor: null,
  focused: null,
  renaming: null,
  creating: null,
  clipboard: null,
}));

/** files.exclude patterns ("**\/.git", "**\/*.pyc"…) tested against a path. */
function excluded(path: string, name: string): boolean {
  const patterns = getSetting('files.exclude');
  for (const [pattern, on] of Object.entries(patterns)) {
    if (!on) continue;
    if (pattern.startsWith('**/') && !/[*?[\]{}]/.test(pattern.slice(3))) {
      if (name.toLowerCase() === pattern.slice(3).toLowerCase()) return true;
      continue;
    }
    const regex = new RegExp(
      `(^|/)${pattern
        .replace(/[.+^$()|\\]/g, '\\$&')
        .replace(/\*\*\//g, '(.*/)?')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')}$`,
      'i',
    );
    if (regex.test(path.replaceAll('\\', '/'))) return true;
  }
  return false;
}

export function setTreeRoot(root: string | null) {
  useTree.setState({
    root,
    nodes: root
      ? {
          [pathKey(root)]: {
            path: root,
            name: basename(root),
            dir: true,
            link: false,
            hidden: false,
          },
        }
      : {},
    children: {},
    expanded: root ? { [pathKey(root)]: true } : {},
    selected: [],
    anchor: null,
    focused: null,
    renaming: null,
    creating: null,
  });
  if (root) void loadDir(root);
}

/** Lists a folder (again) and stores its children. */
export async function loadDir(path: string): Promise<void> {
  const key = pathKey(path);
  let entries: DirEntry[];
  try {
    entries = await backend().fs.readDir(path);
  } catch {
    // Gone: drop it from the tree.
    useTree.setState((s) => {
      const children = { ...s.children };
      delete children[key];
      return { children };
    });
    return;
  }
  useTree.setState((s) => {
    const nodes = { ...s.nodes };
    const childKeys: string[] = [];
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      if (excluded(childPath, entry.name)) continue;
      const childKey = pathKey(childPath);
      nodes[childKey] = {
        path: childPath,
        name: entry.name,
        dir: entry.dir,
        link: entry.link,
        hidden: entry.hidden,
      };
      childKeys.push(childKey);
    }
    return { nodes, children: { ...s.children, [key]: childKeys } };
  });
}

export function isExpanded(key: string): boolean {
  return !!useTree.getState().expanded[key];
}

export async function setExpanded(path: string, open: boolean) {
  const key = pathKey(path);
  useTree.setState((s) => {
    const expanded = { ...s.expanded };
    if (open) expanded[key] = true;
    else delete expanded[key];
    return { expanded };
  });
  if (open && !useTree.getState().children[key]) await loadDir(path);
}

export function toggleDir(path: string) {
  void setExpanded(path, !isExpanded(pathKey(path)));
}

export function collapseAll() {
  const { root } = useTree.getState();
  useTree.setState({ expanded: root ? { [pathKey(root)]: true } : {} });
}

/** The rows on screen: every entry under an expanded folder, depth first. */
export function visibleRows(state: TreeState): Row[] {
  const rows: Row[] = [];
  if (!state.root) return rows;
  const walk = (key: string, depth: number) => {
    if (state.creating && state.creating.parent === key) {
      rows.push({
        key: `__new__${key}`,
        node: { path: '', name: '', dir: state.creating.dir, link: false, hidden: false },
        depth,
        input: state.creating.dir ? 'newFolder' : 'newFile',
      });
    }
    const kids = state.children[key];
    if (!kids) return;
    for (const child of kids) {
      const node = state.nodes[child];
      if (!node) continue;
      rows.push({ key: child, node, depth });
      if (node.dir && state.expanded[child]) walk(child, depth + 1);
    }
  };
  walk(pathKey(state.root), 0);
  return rows;
}

/** Expands the folders above `path` and selects it (auto-reveal of the active file). */
export async function reveal(path: string) {
  const { root } = useTree.getState();
  if (!root || !isUnder(path, root)) return;
  const chain: string[] = [];
  for (
    let dir = dirname(path);
    isUnder(dir, root) && pathKey(dir) !== pathKey(root);
    dir = dirname(dir)
  ) {
    chain.unshift(dir);
  }
  for (const dir of chain) await setExpanded(dir, true);
  const key = pathKey(path);
  useTree.setState({ selected: [key], anchor: key, focused: key });
}

// Disk changes: reload each affected folder once, a moment later.
const pendingReloads = new Set<string>();
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

export function handleTreeChanges(changes: FsChange[]) {
  const { children, root } = useTree.getState();
  if (!root) return;
  for (const change of changes) {
    if (change.kind === 'git') continue;
    if (change.kind === 'rescan') {
      Object.keys(children).forEach((k) => pendingReloads.add(k));
      continue;
    }
    const parent = pathKey(dirname(change.path));
    if (children[parent]) pendingReloads.add(parent);
  }
  if (!pendingReloads.size) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const { nodes } = useTree.getState();
    for (const key of pendingReloads) {
      const node = nodes[key];
      if (node) void loadDir(node.path);
    }
    pendingReloads.clear();
  }, 80);
}

// ── Selection ─────────────────────────────────────────────────────────────────────────────

export function selectOnly(key: string) {
  useTree.setState({ selected: [key], anchor: key, focused: key });
}

export function toggleSelected(key: string) {
  useTree.setState((s) => ({
    selected: s.selected.includes(key) ? s.selected.filter((k) => k !== key) : [...s.selected, key],
    anchor: key,
    focused: key,
  }));
}

export function selectRange(key: string) {
  const state = useTree.getState();
  const rows = visibleRows(state).filter((r) => !r.input);
  const from = rows.findIndex((r) => r.key === (state.anchor ?? key));
  const to = rows.findIndex((r) => r.key === key);
  if (from < 0 || to < 0) return selectOnly(key);
  const [a, b] = from < to ? [from, to] : [to, from];
  useTree.setState({ selected: rows.slice(a, b + 1).map((r) => r.key), focused: key });
}

/** The selected entries' paths (or the focused one). */
export function selectedPaths(): string[] {
  const { selected, nodes, focused } = useTree.getState();
  const keys = selected.length ? selected : focused ? [focused] : [];
  return keys.map((k) => nodes[k]?.path).filter((p): p is string => !!p);
}

// ── File operations ───────────────────────────────────────────────────────────────────────

/** The folder a new entry goes into: the focused folder, or the focused file's folder. */
export function targetFolder(): string | null {
  const { focused, nodes, root } = useTree.getState();
  const node = focused ? nodes[focused] : undefined;
  if (!node) return root;
  return node.dir ? node.path : dirname(node.path);
}

export async function startCreate(dir: boolean, inFolder?: string) {
  const folder = inFolder ?? targetFolder();
  if (!folder) return;
  await setExpanded(folder, true);
  useTree.setState({ creating: { parent: pathKey(folder), dir }, renaming: null });
}

export function cancelCreate() {
  useTree.setState({ creating: null });
}

function validName(name: string): string | null {
  if (!name.trim()) return 'Enter a name.';
  if (/[<>:"|?*]/.test(name)) return 'A name can’t contain < > : " | ? or *.';
  if (/(^|[\\/])(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name)) {
    return 'Windows reserves that name.';
  }
  if (/[. ]$/.test(name)) return 'A name can’t end with a dot or a space.';
  return null;
}

/** Creates the file or folder typed into the inline input. Returns the new path. */
export async function finishCreate(name: string): Promise<string | null> {
  const { creating, nodes } = useTree.getState();
  if (!creating) return null;
  useTree.setState({ creating: null });
  if (!name.trim()) return null;
  const problem = validName(name);
  if (problem) {
    notify('warning', problem);
    return null;
  }
  const parent = nodes[creating.parent]?.path;
  if (!parent) return null;
  const path = join(parent, name);
  try {
    if (creating.dir) await backend().fs.createDir(path);
    else await backend().fs.createFile(path);
    await loadDir(dirname(path));
    const key = pathKey(path);
    useTree.setState({ selected: [key], focused: key, anchor: key });
    return path;
  } catch (err) {
    notify('error', errorMessage(err));
    return null;
  }
}

export function startRename(key?: string) {
  const state = useTree.getState();
  const target = key ?? state.focused;
  if (target && target !== pathKey(state.root ?? '')) {
    useTree.setState({ renaming: target, creating: null });
  }
}

export async function finishRename(newName: string): Promise<void> {
  const { renaming, nodes } = useTree.getState();
  useTree.setState({ renaming: null });
  const node = renaming ? nodes[renaming] : undefined;
  if (!node || newName === node.name || !newName.trim()) return;
  const problem = validName(newName);
  if (problem) {
    notify('warning', problem);
    return;
  }
  const to = join(dirname(node.path), newName);
  try {
    await backend().fs.rename(node.path, to);
    movedOnDisk(node.path, to);
    await loadDir(dirname(node.path));
    const key = pathKey(to);
    useTree.setState({ selected: [key], focused: key, anchor: key });
  } catch (err) {
    notify('error', errorMessage(err));
  }
}

/** Moves the selection to the Recycle Bin (asking first, unless that's switched off). */
export async function deleteSelected(permanently = false) {
  const root = useTree.getState().root;
  const paths = selectedPaths().filter((p) => !root || pathKey(p) !== pathKey(root));
  if (!paths.length) return;
  if (permanently || getSetting('explorer.confirmDelete')) {
    const what = paths.length === 1 ? `"${basename(paths[0]!)}"` : `${paths.length} items`;
    const answer = await ask({
      title: permanently ? `Delete ${what} permanently?` : `Move ${what} to the Recycle Bin?`,
      message: permanently ? "You can't undo this." : 'You can restore it from the Recycle Bin.',
      buttons: [
        { id: 'delete', label: permanently ? 'Delete' : 'Move to Recycle Bin', danger: true },
        { id: 'cancel', label: 'Cancel', primary: true },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'delete') return;
  }
  try {
    await backend().fs.delete(paths, !permanently);
    for (const dir of new Set(paths.map(dirname))) await loadDir(dir);
    useTree.setState({ selected: [] });
  } catch (err) {
    notify(
      'error',
      `Couldn't delete ${paths.length === 1 ? basename(paths[0]!) : 'those items'}.`,
      { detail: errorMessage(err) },
    );
  }
}

export function copySelected(cut: boolean) {
  const paths = selectedPaths();
  if (paths.length) useTree.setState({ clipboard: { paths, cut } });
}

export async function paste(into?: string) {
  const { clipboard } = useTree.getState();
  const folder = into ?? targetFolder();
  if (!clipboard || !folder) return;
  try {
    if (clipboard.cut) {
      const moved = await backend().fs.moveInto(clipboard.paths, folder);
      clipboard.paths.forEach((from, i) => {
        const to = moved[i];
        if (to) movedOnDisk(from, to);
      });
      useTree.setState({ clipboard: null });
      for (const dir of new Set(clipboard.paths.map(dirname))) await loadDir(dir);
    } else {
      await backend().fs.copyInto(clipboard.paths, folder);
    }
    await loadDir(folder);
  } catch (err) {
    notify('error', errorMessage(err));
  }
}

export async function duplicate() {
  const paths = selectedPaths();
  if (!paths.length) return;
  try {
    for (const path of paths) await backend().fs.copyInto([path], dirname(path));
    for (const dir of new Set(paths.map(dirname))) await loadDir(dir);
  } catch (err) {
    notify('error', errorMessage(err));
  }
}

/** Drag and drop inside the explorer. */
export async function moveInto(paths: string[], folder: string) {
  const movable = paths.filter(
    (p) => !isUnder(folder, p) && pathKey(dirname(p)) !== pathKey(folder),
  );
  if (!movable.length) return;
  if (getSetting('explorer.confirmDragAndDrop')) {
    const what = movable.length === 1 ? `"${basename(movable[0]!)}"` : `${movable.length} items`;
    const answer = await ask({
      title: `Move ${what} into "${basename(folder)}"?`,
      buttons: [
        { id: 'move', label: 'Move', primary: true },
        { id: 'cancel', label: 'Cancel' },
      ],
      cancelId: 'cancel',
    });
    if (answer !== 'move') return;
  }
  try {
    const moved = await backend().fs.moveInto(movable, folder);
    movable.forEach((from, i) => {
      const to = moved[i];
      if (to) movedOnDisk(from, to);
    });
    for (const dir of new Set([...movable.map(dirname), folder])) await loadDir(dir);
  } catch (err) {
    notify('error', errorMessage(err));
  }
}
