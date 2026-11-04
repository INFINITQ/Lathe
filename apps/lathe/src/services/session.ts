// Starting where you left off: the folder, editors (with cursors and scroll positions),
// layout, and the text of unsaved editors ("hot exit": closing Lathe never asks; the next start
// brings everything back, still unsaved).

import type { Text } from '@codemirror/state';
import { tabViewState, seedTabViewState } from '../editor/TextEditor';
import {
  type TextDoc,
  dirtyDocuments,
  onDocumentsChanged,
  openDocument,
  restoreDocument,
  saveDocument,
} from '../editor/documents';
import { type Launch, type Stamp, type TextFormat, backend } from '../lib/backend';
import {
  type SavedDebug,
  debugSnapshot,
  persistentChanged,
  restoreDebug,
  useDebug,
} from '../debug/store';
import { debounce } from '../lib/events';
import { resolve, samePath } from '../lib/paths';
import { askToSave } from './dialogs';
import { notify } from './notifications';
import { getSetting } from './settings';
import {
  type Group,
  type Tab,
  type TabKind,
  makeGroup,
  makeTab,
  openPath,
  restoreGroups,
  snapshotEditors,
  tabPath,
  useEditors,
} from '../workbench/editors/store';
import { useLayout } from '../workbench/layout';
import { openFolder, useWorkspace } from '../workbench/workspaceStore';

interface SavedTab {
  kind: TabKind;
  path: string | null;
  docId: string | null;
  untitled: string | null;
  dirty: boolean;
  format: TextFormat | null;
  stamp: Stamp | null;
  pinned: boolean;
  preview: boolean;
  view?: { anchor: number; head: number; top: number } | null;
}

interface SessionFile {
  version: 1;
  folder: string | null;
  layout: Partial<ReturnType<typeof useLayout.getState>>;
  editors: {
    direction: 'row' | 'column';
    sizes: number[];
    active: number;
    groups: { active: number; tabs: SavedTab[] }[];
  };
  /** Breakpoints, watches and the chosen debug configuration. */
  debug?: SavedDebug;
}

const UTF8: TextFormat = { encoding: 'UTF-8', bom: false, crlf: false };
const LAYOUT_KEYS = [
  'sidebarVisible',
  'sidebarWidth',
  'view',
  'panelVisible',
  'panelHeight',
  'panel',
  'outlineOpen',
] as const;

/** Unsaved texts already backed up (Text objects are immutable, so a new one means an edit). */
const backedUp = new Map<string, Text>();

async function backUpDirty(): Promise<string[]> {
  const dirty = dirtyDocuments();
  await Promise.all(
    dirty.map(async (doc) => {
      if (backedUp.get(doc.id) === doc.text) return;
      await backend().session.saveBuffer(doc.id, doc.text.toString());
      backedUp.set(doc.id, doc.text);
    }),
  );
  return dirty.map((d) => d.id);
}

function snapshot(): SessionFile {
  const editors = snapshotEditors();
  const layout = useLayout.getState();
  return {
    version: 1,
    folder: useWorkspace.getState().root,
    layout: Object.fromEntries(LAYOUT_KEYS.map((k) => [k, layout[k]])),
    editors: {
      ...editors,
      groups: editors.groups.map((g) => ({
        active: g.active,
        tabs: g.tabs.map(({ id, ...tab }) => ({ ...tab, view: tabViewState(id) })),
      })),
    },
    debug: debugSnapshot(),
  };
}

/** Saves the session and backs up unsaved editors now. */
export async function flushSession() {
  const keep = await backUpDirty();
  await backend().session.save(snapshot());
  await backend().session.pruneBuffers(keep);
}

/** Saves the session whenever something worth remembering changes. */
export function startSessionAutosave(): () => void {
  const save = debounce(() => void flushSession().catch(() => {}), 1000);
  const stops = [
    useEditors.subscribe(save),
    useLayout.subscribe(save),
    useWorkspace.subscribe(save),
    onDocumentsChanged(save),
    useDebug.subscribe((next, prev) => {
      if (persistentChanged(next, prev)) save();
    }),
  ];
  // Unsaved text is backed up every couple of seconds while you type.
  const timer = setInterval(() => void backUpDirty().catch(() => {}), 2000);
  return () => {
    save.cancel();
    clearInterval(timer);
    stops.forEach((s) => s());
  };
}

async function restoreTab(saved: SavedTab): Promise<Tab | null> {
  if (saved.kind === 'welcome' || saved.kind === 'keybindings' || saved.kind === 'settings') {
    return makeTab({ kind: saved.kind, pinned: saved.pinned, preview: false });
  }
  if (saved.kind === 'preview') {
    const doc = saved.path ? await openDocument(saved.path).catch(() => null) : null;
    return doc && saved.path
      ? makeTab({
          kind: 'preview',
          source: doc.id,
          path: saved.path,
          pinned: saved.pinned,
          preview: false,
        })
      : null;
  }
  if (saved.kind === 'image') {
    return saved.path
      ? makeTab({ kind: 'image', path: saved.path, pinned: saved.pinned, preview: saved.preview })
      : null;
  }
  let doc: TextDoc | null = null;
  if (saved.dirty && saved.docId) {
    const text = await backend()
      .session.loadBuffer(saved.docId)
      .catch(() => null);
    if (text !== null) {
      doc = restoreDocument({
        path: saved.path,
        untitledName: saved.untitled ?? undefined,
        text,
        format: saved.format ?? UTF8,
        stamp: saved.stamp,
      });
    }
  }
  if (!doc && saved.path) doc = await openDocument(saved.path).catch(() => null);
  if (!doc) return null;
  const tab = makeTab({
    kind: saved.kind === 'notebook' ? 'notebook' : 'text',
    docId: doc.id,
    pinned: saved.pinned,
    preview: saved.preview,
  });
  if (saved.view) seedTabViewState(tab.id, doc.id, saved.view);
  return tab;
}

/** Brings back breakpoints and watches, whatever else opens (a launch with files included). */
export function restoreDebugState(raw: unknown) {
  const session = raw as SessionFile | null;
  if (session?.version === 1) restoreDebug(session.debug);
}

/** Brings back the last session. Resolves true if any editor came back. */
export async function restoreSession(raw: unknown): Promise<boolean> {
  const session = raw as SessionFile | null;
  if (!session || session.version !== 1) return false;
  if (session.layout) {
    const layout: Record<string, unknown> = {};
    for (const key of LAYOUT_KEYS) if (key in session.layout) layout[key] = session.layout[key];
    useLayout.setState(layout);
  }
  if (session.folder && getSetting('window.restoreFolder')) {
    await openFolder(session.folder, { keepEditors: true });
  }
  const saved = session.editors?.groups ?? [];
  const slots: (Tab | null)[][] = saved.map((g) => g.tabs.map(() => null));
  // Previews last: they open their file from disk, which mustn't get ahead of an unsaved copy.
  for (const previews of [false, true]) {
    for (const [g, group] of saved.entries()) {
      for (const [t, tab] of group.tabs.entries()) {
        if ((tab.kind === 'preview') !== previews) continue;
        slots[g]![t] = await restoreTab(tab);
      }
    }
  }
  const groups: Group[] = [];
  saved.forEach((group, g) => {
    const tabs = slots[g]!.filter((t): t is Tab => !!t);
    if (tabs.length) groups.push(makeGroup(tabs, group.active));
  });
  if (groups.length) {
    restoreGroups(groups, session.editors.direction, session.editors.sizes, session.editors.active);
  }
  return groups.length > 0;
}

const WAIT_MARKER = '--wait-marker=';

/** Opens what Lathe was started with: folders and files, `file:line:column` included. With
 * `lathe --wait`, the command returns once the files' editors have all closed. */
export async function handleLaunch(launch: Launch): Promise<boolean> {
  const marker = launch.args.find((a) => a.startsWith(WAIT_MARKER))?.slice(WAIT_MARKER.length);
  const paths = launch.args.filter((a) => a && !a.startsWith('-'));
  const files: string[] = [];
  for (const arg of paths) {
    const match = /^(.*?)(?::(\d+)(?::(\d+))?)?$/.exec(arg);
    const file = resolve(launch.cwd || 'C:\\', match?.[1] ?? arg);
    const line = match?.[2] ? Number(match[2]) : undefined;
    const column = match?.[3] ? Number(match[3]) : undefined;
    const info = await backend().fs.stat(file);
    if (info?.dir) await openFolder(file);
    else if (info) {
      await openPath(file, { selection: line ? { line, column } : undefined });
      files.push(file);
    } else notify('warning', `${arg} doesn't exist.`);
  }
  if (marker) releaseWhenClosed(marker, files);
  return paths.length > 0;
}

/** Lets `lathe --wait` return once no editor shows any of `files` (at once if there are none). */
function releaseWhenClosed(marker: string, files: string[]) {
  const showing = () =>
    useEditors.getState().groups.some((g) =>
      g.tabs.some((t) => {
        const path = t.kind === 'preview' ? null : tabPath(t);
        return !!path && files.some((f) => samePath(f, path));
      }),
    );
  const release = () =>
    void backend()
      .releaseWait(marker)
      .catch(() => {});
  if (!showing()) {
    release();
    return;
  }
  const stop = useEditors.subscribe(() => {
    if (showing()) return;
    stop();
    release();
  });
}

/** Files and folders dropped on the window from File Explorer. */
export async function openDropped(paths: string[]) {
  for (const path of paths) {
    const info = await backend().fs.stat(path);
    if (info?.dir) await openFolder(path);
    else if (info) await openPath(path);
  }
}

/** Before the window closes: hot exit, or the usual "save changes?" question. */
export async function beforeClose(): Promise<boolean> {
  if (!getSetting('files.hotExit')) {
    const dirty = dirtyDocuments();
    if (dirty.length) {
      const answer = await askToSave(dirty[0]!.name, dirty.length);
      if (answer === 'cancel') return false;
      if (answer === 'save') {
        for (const doc of dirty) if (!(await saveDocument(doc))) return false;
      }
    }
  }
  await flushSession();
  return true;
}
