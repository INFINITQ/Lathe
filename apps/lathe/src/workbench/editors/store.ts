// Editor groups and their tabs. Groups sit side by side (or stacked); each has tabs, one of
// them active. A "preview" tab (single click in the explorer) is reused by the next preview
// until you edit it, double-click it, or pin it, as in VS Code.

import { create } from 'zustand';
import { newId } from '../../lib/events';
import { basename, extname, samePath } from '../../lib/paths';
import {
  type TextDoc,
  createUntitled,
  dirtyDocuments,
  documentForPath,
  getDocument,
  openDocument,
  releaseDocument,
  saveDocument,
} from '../../editor/documents';
import { askToSave } from '../../services/dialogs';
import { notify } from '../../services/notifications';
import { getSetting } from '../../services/settings';
import { errorKind, errorMessage } from '../../lib/backend';

export type TabKind =
  'text' | 'image' | 'welcome' | 'diff' | 'notebook' | 'keybindings' | 'settings' | 'preview';

/** Tabs there's only one of (in a group): they show Lathe itself, not a file. */
export type SingletonKind = 'welcome' | 'keybindings' | 'settings';

/** A comparison of two versions of a file. */
export interface DiffSpec {
  path: string;
  /** The older side: a Git revision ("HEAD", "index", a commit) or a local history entry. */
  left: { git: string } | { history: string };
  /** The newer side: the file as it is in the editor (live, editable), or a Git revision. */
  right: 'working' | { git: string };
  title: string;
}

export interface Tab {
  id: string;
  kind: TabKind;
  /** Text and notebook tabs: the document shown. */
  docId?: string;
  /** Image tabs: the file shown. Preview tabs: the file previewed (none for an untitled one). */
  path?: string;
  /** Preview tabs: the document previewed (Markdown). */
  source?: string;
  /** Diff tabs: what is compared. */
  diff?: DiffSpec;
  pinned: boolean;
  preview: boolean;
}

export interface Group {
  id: string;
  tabs: Tab[];
  activeTab: string | null;
  /** Tab ids, most recently used first (closing a tab goes back to the previous one). */
  recent: string[];
}

interface ClosedTab {
  kind: TabKind;
  path: string;
}

interface EditorsState {
  groups: Group[];
  activeGroup: string;
  direction: 'row' | 'column';
  /** Relative sizes of the groups (fractions that add up to 1). */
  sizes: number[];
  closed: ClosedTab[];
  /** Bumped when a selection is waiting for an editor that may already be on screen. */
  selectionRequest: number;
}

function emptyGroup(): Group {
  return { id: newId(), tabs: [], activeTab: null, recent: [] };
}

const first = emptyGroup();

export const useEditors = create<EditorsState>(() => ({
  groups: [first],
  activeGroup: first.id,
  direction: 'row',
  sizes: [1],
  closed: [],
  selectionRequest: 0,
}));

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
]);

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path));
}

function findGroup(id: string | undefined): Group | undefined {
  const { groups, activeGroup } = useEditors.getState();
  return groups.find((g) => g.id === (id ?? activeGroup));
}

function replaceGroup(next: Group) {
  useEditors.setState((s) => ({ groups: s.groups.map((g) => (g.id === next.id ? next : g)) }));
}

function touch(group: Group, tabId: string): Group {
  return {
    ...group,
    activeTab: tabId,
    recent: [tabId, ...group.recent.filter((t) => t !== tabId)],
  };
}

/** The tab you're looking at: the active group's active tab. */
export function activeTab(): { group: Group; tab: Tab | null; doc: TextDoc | null } {
  const { groups, activeGroup } = useEditors.getState();
  const group = groups.find((g) => g.id === activeGroup) ?? groups[0]!;
  const tab = group.tabs.find((t) => t.id === group.activeTab) ?? null;
  const doc = tab?.docId ? (getDocument(tab.docId) ?? null) : null;
  return { group, tab, doc };
}

export function tabTitle(tab: Tab): string {
  if (tab.kind === 'welcome') return 'Welcome';
  if (tab.kind === 'keybindings') return 'Keyboard shortcuts';
  if (tab.kind === 'settings') return 'Settings';
  if (tab.kind === 'preview') {
    const doc = getDocument(tab.source ?? '');
    return `Preview ${doc?.name ?? basename(tab.path ?? '')}`;
  }
  if (tab.kind === 'image') return basename(tab.path ?? '');
  if (tab.kind === 'diff') return tab.diff?.title ?? 'Diff';
  return getDocument(tab.docId ?? '')?.name ?? '';
}

export function tabPath(tab: Tab): string | null {
  if (tab.kind === 'image' || tab.kind === 'preview') return tab.path ?? null;
  if (tab.kind === 'text' || tab.kind === 'notebook') {
    return getDocument(tab.docId ?? '')?.path ?? null;
  }
  return null;
}

export interface OpenOptions {
  /** Open as a preview (reused by the next preview) unless previews are off. */
  preview?: boolean;
  /** Group to open in (default: the active one); 'side' opens a new group beside it. */
  group?: string | 'side';
  /** Don't make it the active tab. */
  background?: boolean;
  /** Put the cursor here (1-based line and column), or select up to the end given. */
  selection?: PendingSelection;
  /** Leave the keyboard focus where it is (a search result opened from the list). */
  preserveFocus?: boolean;
}

export interface PendingSelection {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  preserveFocus?: boolean;
}

/** Where the next editor of a document should put the cursor (read when it mounts). */
export const pendingSelections = new Map<string, PendingSelection>();

function targetGroup(option: OpenOptions['group']): Group {
  if (option === 'side') return splitGroup('right', false);
  return findGroup(option) ?? useEditors.getState().groups[0]!;
}

function insertTab(group: Group, tab: Tab, options: OpenOptions): Group {
  let tabs = group.tabs;
  if (tab.preview) {
    // The new preview replaces the old one, in its place.
    const old = tabs.findIndex((t) => t.preview);
    if (old >= 0) {
      const replaced = tabs[old]!;
      tabs = tabs.map((t, i) => (i === old ? tab : t));
      queueMicrotask(() => afterTabClosed(replaced));
      const next = { ...group, tabs, recent: group.recent.filter((id) => id !== replaced.id) };
      return options.background ? next : touch(next, tab.id);
    }
  }
  const at = group.activeTab ? tabs.findIndex((t) => t.id === group.activeTab) + 1 : tabs.length;
  const next = { ...group, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)] };
  return options.background && group.activeTab !== null ? next : touch(next, tab.id);
}

function activate(group: Group, tab: Tab, options: OpenOptions) {
  let next = group;
  if (!options.preview && tab.preview) {
    next = {
      ...group,
      tabs: group.tabs.map((t) => (t.id === tab.id ? { ...t, preview: false } : t)),
    };
  }
  if (!options.background) next = touch(next, tab.id);
  replaceGroup(next);
  if (!options.background) useEditors.setState({ activeGroup: group.id });
}

/** Opens a file in an editor (or shows it if it's already open there). */
export async function openPath(path: string, options: OpenOptions = {}): Promise<void> {
  const previewing = (options.preview ?? false) && getSetting('workbench.editor.enablePreview');
  const opts = { ...options, preview: previewing };
  if (isImagePath(path)) {
    const group = targetGroup(options.group);
    const existing = group.tabs.find((t) => t.kind === 'image' && t.path && samePath(t.path, path));
    if (existing) return activate(group, existing, opts);
    const tab: Tab = { id: newId(), kind: 'image', path, pinned: false, preview: previewing };
    replaceGroup(insertTab(group, tab, opts));
    if (!options.background) useEditors.setState({ activeGroup: group.id });
    return;
  }
  let doc: TextDoc;
  try {
    doc = await openDocument(path);
  } catch (err) {
    const kind = errorKind(err);
    notify('error', `Couldn't open ${basename(path)}.`, {
      detail: kind === 'binary' ? "It's a binary file, not text." : errorMessage(err),
    });
    return;
  }
  openDoc(doc, opts);
}

/** Shows a document in an editor. */
export function openDoc(doc: TextDoc, options: OpenOptions = {}) {
  const group = targetGroup(options.group);
  if (options.selection) {
    pendingSelections.set(doc.id, { ...options.selection, preserveFocus: options.preserveFocus });
    useEditors.setState((s) => ({ selectionRequest: s.selectionRequest + 1 }));
  }
  const existing = group.tabs.find((t) => t.docId === doc.id);
  if (existing) {
    activate(group, existing, options);
    return;
  }
  const tab: Tab = {
    id: newId(),
    // .ipynb files open in the notebook editor.
    kind: doc.path && /\.ipynb$/i.test(doc.path) ? 'notebook' : 'text',
    docId: doc.id,
    pinned: false,
    preview: options.preview ?? false,
  };
  replaceGroup(insertTab(group, tab, options));
  if (!options.background) useEditors.setState({ activeGroup: group.id });
}

const sameDiff = (a: DiffSpec, b: DiffSpec) =>
  samePath(a.path, b.path) &&
  JSON.stringify([a.left, a.right]) === JSON.stringify([b.left, b.right]);

/** Opens a comparison (or shows it if it's open), as a preview tab unless asked otherwise. */
export function openDiff(spec: DiffSpec, options: OpenOptions = {}) {
  const group = targetGroup(options.group);
  const existing = group.tabs.find((t) => t.kind === 'diff' && t.diff && sameDiff(t.diff, spec));
  const preview = (options.preview ?? true) && getSetting('workbench.editor.enablePreview');
  if (existing) return activate(group, existing, { ...options, preview });
  const tab: Tab = { id: newId(), kind: 'diff', diff: spec, pinned: false, preview };
  replaceGroup(insertTab(group, tab, { ...options, preview }));
  if (!options.background) useEditors.setState({ activeGroup: group.id });
}

export function newUntitled() {
  openDoc(createUntitled());
}

/** Shows the Welcome page, Keyboard shortcuts or Settings: where it's open already (the active
 * group first), or as a new tab in the active group. */
export function showEditorTab(kind: SingletonKind) {
  const { groups } = useEditors.getState();
  const active = findGroup(undefined)!;
  for (const group of [active, ...groups.filter((g) => g.id !== active.id)]) {
    const existing = group.tabs.find((t) => t.kind === kind);
    if (existing) {
      activate(group, existing, {});
      useEditors.setState({ activeGroup: group.id });
      return;
    }
  }
  const tab: Tab = { id: newId(), kind, pinned: false, preview: false };
  replaceGroup(insertTab(active, tab, {}));
  useEditors.setState({ activeGroup: active.id });
}

export function showWelcome() {
  showEditorTab('welcome');
}

/** Opens a preview of a Markdown document: in the active group, or the one beside it. */
export function openPreview(doc: TextDoc, side: boolean) {
  const { groups, activeGroup } = useEditors.getState();
  const index = groups.findIndex((g) => g.id === activeGroup);
  const group = side ? (groups[index + 1] ?? splitGroup('right', false)) : findGroup(undefined)!;
  const existing = group.tabs.find((t) => t.kind === 'preview' && t.source === doc.id);
  if (existing) {
    activate(group, existing, {});
    useEditors.setState({ activeGroup: side ? activeGroup : group.id });
    return;
  }
  const tab: Tab = {
    id: newId(),
    kind: 'preview',
    source: doc.id,
    path: doc.path ?? undefined,
    pinned: false,
    preview: false,
  };
  replaceGroup(insertTab(group, tab, {}));
  // To the side, the keyboard stays in the editor you're writing in.
  useEditors.setState({ activeGroup: side ? activeGroup : group.id });
}

/** The first edit (or a double-click) turns a preview tab into a regular one. */
export function keepTab(groupId: string, tabId: string) {
  const group = findGroup(groupId);
  if (!group || !group.tabs.some((t) => t.id === tabId && t.preview)) return;
  replaceGroup({
    ...group,
    tabs: group.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)),
  });
}

export function keepDocTabs(docId: string) {
  for (const group of useEditors.getState().groups) {
    for (const tab of group.tabs) {
      if (tab.docId === docId && tab.preview) keepTab(group.id, tab.id);
    }
  }
}

export function setPinned(groupId: string, tabId: string, pinned: boolean) {
  const group = findGroup(groupId);
  if (!group) return;
  const tabs = group.tabs.map((t) => (t.id === tabId ? { ...t, pinned, preview: false } : t));
  // Pinned tabs go first, keeping their order.
  tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  replaceGroup({ ...group, tabs });
}

export function activateTab(groupId: string, tabId: string) {
  const group = findGroup(groupId);
  if (!group) return;
  replaceGroup(touch(group, tabId));
  useEditors.setState({ activeGroup: groupId });
}

export function focusGroup(groupId: string) {
  if (findGroup(groupId)) useEditors.setState({ activeGroup: groupId });
}

/** How many tabs (in all groups) show this document. */
function tabsShowing(docId: string): number {
  return useEditors
    .getState()
    .groups.reduce((n, g) => n + g.tabs.filter((t) => t.docId === docId).length, 0);
}

/** Whether a preview tab (in any group) shows this document. */
function previewed(docId: string): boolean {
  return useEditors
    .getState()
    .groups.some((g) => g.tabs.some((t) => t.kind === 'preview' && t.source === docId));
}

function afterTabClosed(tab: Tab) {
  const path = tabPath(tab);
  if (tab.kind === 'text' && tab.docId && tabsShowing(tab.docId) === 0) {
    const doc = getDocument(tab.docId);
    // A preview keeps a saved document; one you chose not to save goes (the preview reloads it).
    if (doc && (doc.dirty || !previewed(doc.id))) releaseDocument(doc);
  }
  if (tab.kind === 'preview') {
    // By path too: the preview may have reopened its file under a new id.
    const doc = getDocument(tab.source ?? '') ?? (tab.path ? documentForPath(tab.path) : undefined);
    if (doc && !doc.dirty && tabsShowing(doc.id) === 0 && !previewed(doc.id)) {
      releaseDocument(doc);
    }
  }
  if (path && (tab.kind === 'text' || tab.kind === 'image' || tab.kind === 'notebook')) {
    useEditors.setState((s) => ({ closed: [{ kind: tab.kind, path }, ...s.closed].slice(0, 30) }));
  }
}

/**
 * Closes a tab. A dirty document shown nowhere else asks first. Resolves false if you chose
 * Cancel.
 */
export async function closeTab(groupId: string, tabId: string): Promise<boolean> {
  const group = findGroup(groupId);
  const tab = group?.tabs.find((t) => t.id === tabId);
  if (!group || !tab) return true;
  if (tab.kind === 'text' && tab.docId && tabsShowing(tab.docId) === 1) {
    const doc = getDocument(tab.docId);
    if (doc?.dirty) {
      activateTab(groupId, tabId);
      const answer = await askToSave(doc.name);
      if (answer === 'cancel') return false;
      if (answer === 'save' && !(await saveDocument(doc))) return false;
    }
  }
  removeTab(groupId, tabId);
  return true;
}

function removeTab(groupId: string, tabId: string) {
  const group = findGroup(groupId);
  const tab = group?.tabs.find((t) => t.id === tabId);
  if (!group || !tab) return;
  const tabs = group.tabs.filter((t) => t.id !== tabId);
  const recent = group.recent.filter((t) => t !== tabId);
  const activeTabId =
    group.activeTab === tabId ? (recent[0] ?? tabs.at(-1)?.id ?? null) : group.activeTab;
  const state = useEditors.getState();
  if (tabs.length === 0 && state.groups.length > 1) {
    // An empty group closes, unless it's the last one.
    const index = state.groups.findIndex((g) => g.id === groupId);
    const groups = state.groups.filter((g) => g.id !== groupId);
    const nextActive =
      state.activeGroup === groupId ? groups[Math.max(0, index - 1)]!.id : state.activeGroup;
    useEditors.setState({
      groups,
      sizes: groups.map(() => 1 / groups.length),
      activeGroup: nextActive,
    });
  } else {
    replaceGroup({ ...group, tabs, recent, activeTab: activeTabId });
  }
  afterTabClosed(tab);
}

/** Closes several tabs of a group, asking about unsaved ones, in order. */
export async function closeTabs(
  groupId: string,
  which: 'others' | 'right' | 'saved' | 'all',
  tabId?: string,
) {
  const group = findGroup(groupId);
  if (!group) return;
  const index = group.tabs.findIndex((t) => t.id === tabId);
  const targets = group.tabs.filter((t, i) => {
    if (t.pinned && which !== 'all') return false;
    if (which === 'others') return t.id !== tabId;
    if (which === 'right') return i > index;
    if (which === 'saved') return !(t.docId && getDocument(t.docId)?.dirty);
    return true;
  });
  for (const tab of targets) {
    if (!(await closeTab(groupId, tab.id))) return;
  }
}

/** Closes everything; resolves false if you cancelled a "save changes?" question. */
export async function closeAllEditors(): Promise<boolean> {
  const dirty = dirtyDocuments();
  if (dirty.length > 1) {
    const answer = await askToSave('', dirty.length);
    if (answer === 'cancel') return false;
    if (answer === 'save') {
      for (const doc of dirty) if (!(await saveDocument(doc))) return false;
    }
    for (const group of useEditors.getState().groups) {
      for (const tab of group.tabs) removeTab(group.id, tab.id);
    }
    return true;
  }
  for (const group of useEditors.getState().groups) {
    for (const tab of [...group.tabs]) if (!(await closeTab(group.id, tab.id))) return false;
  }
  return true;
}

/** Reopens the last closed tab (Ctrl+Shift+T). */
export async function reopenClosed() {
  const [last, ...rest] = useEditors.getState().closed;
  if (!last) return;
  useEditors.setState({ closed: rest });
  await openPath(last.path);
}

/** Opens a new group beside the active one, showing the active tab's document too. */
export function splitGroup(side: 'right' | 'down', copyActive = true): Group {
  const state = useEditors.getState();
  const current = findGroup(undefined)!;
  const group = emptyGroup();
  const tab = current.tabs.find((t) => t.id === current.activeTab);
  if (copyActive && tab && tab.kind !== 'welcome') {
    const copy: Tab = { ...tab, id: newId(), preview: false, pinned: false };
    group.tabs = [copy];
    group.activeTab = copy.id;
    group.recent = [copy.id];
  }
  const direction =
    state.groups.length === 1 ? (side === 'down' ? 'column' : 'row') : state.direction;
  const index = state.groups.findIndex((g) => g.id === current.id);
  const groups = [...state.groups.slice(0, index + 1), group, ...state.groups.slice(index + 1)];
  useEditors.setState({
    groups,
    direction,
    sizes: groups.map(() => 1 / groups.length),
    activeGroup: group.id,
  });
  return group;
}

/** Moves a tab within a group or to another one (drag and drop). */
export function moveTab(fromGroupId: string, tabId: string, toGroupId: string, toIndex: number) {
  const state = useEditors.getState();
  const from = state.groups.find((g) => g.id === fromGroupId);
  const to = state.groups.find((g) => g.id === toGroupId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !to || !tab) return;
  if (from.id === to.id) {
    const tabs = from.tabs.filter((t) => t.id !== tabId);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    replaceGroup({ ...from, tabs });
    return;
  }
  // Another group: if it already shows that document, just go there.
  const already = to.tabs.find(
    (t) => (t.docId && t.docId === tab.docId) || (t.path && t.path === tab.path),
  );
  const moved: Tab = { ...tab, preview: false };
  const toTabs = already
    ? to.tabs
    : [...to.tabs.slice(0, toIndex), moved, ...to.tabs.slice(toIndex)];
  const nextTo = touch({ ...to, tabs: toTabs }, already?.id ?? moved.id);
  useEditors.setState({
    groups: state.groups.map((g) => (g.id === to.id ? nextTo : g)),
    activeGroup: to.id,
  });
  if (already) {
    removeTab(from.id, tabId);
  } else {
    // The tab lives on in the other group: drop it here without releasing its document.
    const source = useEditors.getState().groups.find((g) => g.id === from.id)!;
    const tabs = source.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0 && useEditors.getState().groups.length > 1) {
      const groups = useEditors.getState().groups.filter((g) => g.id !== from.id);
      useEditors.setState({ groups, sizes: groups.map(() => 1 / groups.length) });
    } else {
      const recent = source.recent.filter((t) => t !== tabId);
      replaceGroup({
        ...source,
        tabs,
        recent,
        activeTab:
          source.activeTab === tabId ? (recent[0] ?? tabs.at(-1)?.id ?? null) : source.activeTab,
      });
    }
  }
}

/** Ctrl+Tab / Ctrl+PageDown: the next (or previous) tab in the active group. */
export function cycleTab(delta: 1 | -1, byOrder = true) {
  const group = findGroup(undefined);
  if (!group || group.tabs.length < 2) return;
  const order = byOrder ? group.tabs.map((t) => t.id) : group.recent;
  const at = order.indexOf(group.activeTab ?? '');
  const next = order[(at + delta + order.length) % order.length];
  if (next) activateTab(group.id, next);
}

/** Moves focus to the group at `index` (Ctrl+1, Ctrl+2…), creating the next one if needed. */
export function focusGroupAt(index: number) {
  const { groups } = useEditors.getState();
  const group = groups[index];
  if (group) {
    focusGroup(group.id);
    return;
  }
  if (index === groups.length) splitGroup('right');
}

export function setGroupSizes(sizes: number[]) {
  useEditors.setState({ sizes });
}

/** Every open tab of every group, for the session. */
export function snapshotEditors() {
  const state = useEditors.getState();
  return {
    direction: state.direction,
    sizes: state.sizes,
    active: state.groups.findIndex((g) => g.id === state.activeGroup),
    groups: state.groups.map((g) => ({
      active: g.tabs.findIndex((t) => t.id === g.activeTab),
      tabs: g.tabs
        .map((t) => {
          const doc = t.docId ? getDocument(t.docId) : undefined;
          return {
            id: t.id,
            kind: t.kind,
            path: tabPath(t),
            docId: doc?.id ?? null,
            untitled: doc?.untitledName ?? null,
            dirty: doc?.dirty ?? false,
            format: doc?.format ?? null,
            stamp: doc?.stamp ?? null,
            pinned: t.pinned,
            preview: t.preview,
          };
        })
        .filter(
          (t) =>
            t.kind === 'welcome' ||
            t.kind === 'keybindings' ||
            t.kind === 'settings' ||
            t.path ||
            t.untitled,
        ),
    })),
  };
}

export type EditorsSnapshot = ReturnType<typeof snapshotEditors>;

/** Replaces all groups (session restore). */
export function restoreGroups(
  groups: Group[],
  direction: 'row' | 'column',
  sizes: number[],
  active: number,
) {
  if (!groups.length) return;
  useEditors.setState({
    groups,
    direction,
    sizes: sizes.length === groups.length ? sizes : groups.map(() => 1 / groups.length),
    activeGroup: groups[Math.max(0, Math.min(active, groups.length - 1))]!.id,
  });
}

export function makeGroup(tabs: Tab[], activeIndex: number): Group {
  const activeTabId = tabs[activeIndex]?.id ?? tabs[0]?.id ?? null;
  return { id: newId(), tabs, activeTab: activeTabId, recent: activeTabId ? [activeTabId] : [] };
}

export function makeTab(init: Omit<Tab, 'id'>): Tab {
  return { ...init, id: newId() };
}
