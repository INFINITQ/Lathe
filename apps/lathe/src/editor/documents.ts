// Documents: one per open file (or untitled buffer), shared by every editor showing it, so
// split editors of the same file stay in sync. A document knows how its file is stored
// (encoding, BOM, line endings) and what's on disk, which is how "dirty" is decided.

import type { LanguageDescription } from '@codemirror/language';
import { Annotation, ChangeSet, type ChangeSpec, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useSyncExternalStore } from 'react';
import {
  type FsChange,
  type Stamp,
  type TextFormat,
  backend,
  errorKind,
  errorMessage,
} from '../lib/backend';
import { newId } from '../lib/events';
import { basename, pathKey, samePath } from '../lib/paths';
import { ask } from '../services/dialogs';
import { notify } from '../services/notifications';
import { getSetting, useSettings } from '../services/settings';
import { detectIndent, detectLanguage, languageIdOf } from './languages';

/** Marks transactions that copy a change from one editor of a document to the others. */
export const syncAnnotation = Annotation.define<boolean>();

const UTF8: TextFormat = { encoding: 'UTF-8', bom: false, crlf: false };

export class TextDoc {
  readonly id = newId();
  path: string | null;
  untitledName: string | null;
  format: TextFormat;
  stamp: Stamp | null;
  readOnly: boolean;
  text: Text;
  language: LanguageDescription | null;
  indent: { tabs: boolean; size: number } | null;
  /** The file changed on disk while you had unsaved changes. */
  conflict = false;
  /** The file was deleted (or moved away) on disk. */
  deleted = false;
  /** Editors showing this document right now. */
  readonly views = new Set<EditorView>();
  /** Told whenever the text changes (a notebook re-reads its JSON after a reload). */
  readonly textListeners = new Set<() => void>();
  private saved: Text | null;
  private dirtyNow: boolean;

  constructor(init: {
    path: string | null;
    untitledName?: string;
    text: string;
    format: TextFormat;
    stamp: Stamp | null;
    readOnly?: boolean;
    saved?: boolean;
  }) {
    this.path = init.path;
    this.untitledName = init.untitledName ?? null;
    this.format = init.format;
    this.stamp = init.stamp;
    this.readOnly = init.readOnly ?? false;
    this.text = Text.of(init.text.split('\n'));
    this.saved = init.saved === false ? null : this.text;
    this.dirtyNow = init.saved === false && init.text.length > 0;
    this.language = detectLanguage(init.path, init.text);
    this.indent = detectIndent(init.text);
  }

  get name(): string {
    return this.path ? basename(this.path) : (this.untitledName ?? 'Untitled');
  }

  get languageId(): string {
    return languageIdOf(this.language);
  }

  get dirty(): boolean {
    return this.dirtyNow || this.deleted;
  }

  /** Takes in the editors' latest text. */
  setText(next: Text) {
    this.text = next;
    for (const listener of this.textListeners) listener();
    // Comparing whole texts only when the lengths match keeps typing cheap.
    const dirty = !this.saved || next.length !== this.saved.length || !next.eq(this.saved);
    if (dirty !== this.dirtyNow) {
      this.dirtyNow = dirty;
      changed();
    }
  }

  /** The text now on disk is `text` (after a save or a reload). */
  markSaved(stamp: Stamp | null, text: Text = this.text) {
    this.saved = text;
    this.stamp = stamp;
    this.deleted = false;
    this.conflict = false;
    this.dirtyNow = !text.eq(this.text);
    changed();
  }

  /** Forgets what's on disk (a restored unsaved buffer): dirty until saved. */
  markUnsaved() {
    this.dirtyNow = true;
    changed();
  }

  setFormat(format: TextFormat) {
    this.format = format;
    this.dirtyNow = true;
    changed();
  }

  setLanguage(language: LanguageDescription | null) {
    this.language = language;
    changed();
  }

  /**
   * Replaces the content (a reload from disk), as one change from the common prefix to the
   * common suffix, so cursors and undo history outside the changed part stay put.
   */
  replaceContent(next: string) {
    const current = this.text.toString();
    if (current === next) return;
    let start = 0;
    const max = Math.min(current.length, next.length);
    while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
    let endCur = current.length;
    let endNext = next.length;
    while (
      endCur > start &&
      endNext > start &&
      current.charCodeAt(endCur - 1) === next.charCodeAt(endNext - 1)
    ) {
      endCur--;
      endNext--;
    }
    const change: ChangeSpec = { from: start, to: endCur, insert: next.slice(start, endNext) };
    const [view] = this.views;
    if (view) {
      // The sync extension copies it to the other editors and calls setText.
      view.dispatch({ changes: change });
    } else {
      this.setText(Text.of(next.split('\n')));
    }
  }

  /** Applies edits (offsets into the current text) as one change, undone in one step. */
  applyEdits(changes: { from: number; to: number; insert: string }[]) {
    if (!changes.length) return;
    const [view] = this.views;
    if (view) {
      view.dispatch({ changes, userEvent: 'input.replace' });
    } else {
      this.setText(ChangeSet.of(changes, this.text.length).apply(this.text));
    }
  }
}

const docs = new Map<string, TextDoc>();
const byPath = new Map<string, TextDoc>();
const opening = new Map<string, Promise<TextDoc>>();
let version = 0;
let pendingBump = false;
const subscribers = new Set<() => void>();

/** Something about some document changed (dirty, name, format…): repaint once per frame. */
function changed() {
  if (pendingBump) return;
  pendingBump = true;
  const flush = () => {
    pendingBump = false;
    version++;
    subscribers.forEach((s) => s());
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 0);
}

/** Calls `listener` (at most once per frame) when any document's state changes. */
export function onDocumentsChanged(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** React hook: re-renders when any document's state changes. */
export function useDocumentsVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => version,
  );
}

export function getDocument(id: string): TextDoc | undefined {
  return docs.get(id);
}

export function documentForPath(path: string): TextDoc | undefined {
  return byPath.get(pathKey(path));
}

export function allDocuments(): TextDoc[] {
  return [...docs.values()];
}

export function dirtyDocuments(): TextDoc[] {
  return allDocuments().filter((d) => d.dirty);
}

function register(doc: TextDoc): TextDoc {
  docs.set(doc.id, doc);
  if (doc.path) byPath.set(pathKey(doc.path), doc);
  changed();
  return doc;
}

/** Opens a file as a document (or returns the one already open). */
export function openDocument(path: string): Promise<TextDoc> {
  const existing = documentForPath(path);
  if (existing) return Promise.resolve(existing);
  const key = pathKey(path);
  const pending = opening.get(key);
  if (pending) return pending;
  const promise = backend()
    .fs.readText(path)
    .then((file) =>
      register(
        new TextDoc({
          path,
          text: file.text,
          format: file.format,
          stamp: file.stamp,
          readOnly: file.readOnly,
        }),
      ),
    )
    .finally(() => opening.delete(key));
  opening.set(key, promise);
  return promise;
}

/** A new, empty, unsaved document ("Untitled-1"). */
export function createUntitled(text = ''): TextDoc {
  const taken = new Set(allDocuments().map((d) => d.untitledName));
  let n = 1;
  while (taken.has(`Untitled-${n}`)) n++;
  return register(
    new TextDoc({
      path: null,
      untitledName: `Untitled-${n}`,
      text,
      format: UTF8,
      stamp: null,
      saved: false,
    }),
  );
}

/** Restores a document from the session (unsaved text kept in a backup). */
export function restoreDocument(init: {
  path: string | null;
  untitledName?: string;
  text: string;
  format: TextFormat;
  stamp: Stamp | null;
}): TextDoc {
  if (init.path) {
    const existing = documentForPath(init.path);
    if (existing) return existing;
  }
  const doc = register(new TextDoc({ ...init, saved: false }));
  doc.markUnsaved();
  return doc;
}

/** Drops a document nobody shows any more. */
export function releaseDocument(doc: TextDoc) {
  docs.delete(doc.id);
  if (doc.path && byPath.get(pathKey(doc.path)) === doc) byPath.delete(pathKey(doc.path));
  void backend().session.removeBuffer(doc.id);
  changed();
}

/** Applies "trim trailing whitespace" and "insert final newline" before saving. */
function beforeSave(doc: TextDoc) {
  const language = doc.languageId;
  const trim = getSetting('files.trimTrailingWhitespace', language);
  const finalNewline = getSetting('files.insertFinalNewline', language);
  if (!trim && !finalNewline) return;
  const changes: ChangeSpec[] = [];
  if (trim) {
    for (let n = 1; n <= doc.text.lines; n++) {
      const line = doc.text.line(n);
      const match = /[ \t]+$/.exec(line.text);
      if (match) changes.push({ from: line.to - match[0].length, to: line.to });
    }
  }
  if (finalNewline && doc.text.length > 0 && doc.text.sliceString(doc.text.length - 1) !== '\n') {
    changes.push({ from: doc.text.length, insert: '\n' });
  }
  if (!changes.length) return;
  const [view] = doc.views;
  if (view) view.dispatch({ changes });
  else {
    let text = doc.text.toString();
    if (trim) text = text.replace(/[ \t]+$/gm, '');
    if (finalNewline && !text.endsWith('\n')) text += '\n';
    doc.setText(Text.of(text.split('\n')));
  }
}

/**
 * Saves a document. Untitled documents (and `as: true`) ask where first. Resolves false when
 * the save didn't happen (cancelled or failed; failures are shown as a notification).
 */
type SaveParticipant = (doc: TextDoc) => Promise<void>;
const saveParticipants: SaveParticipant[] = [];
const savedListeners = new Set<(doc: TextDoc) => void>();

/** Runs before every save (formatting on save); errors don't stop the save. */
export function addSaveParticipant(participant: SaveParticipant) {
  saveParticipants.push(participant);
}

/** Called after a document is saved (language servers want didSave). */
export function onDocumentSaved(listener: (doc: TextDoc) => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}

export async function saveDocument(
  doc: TextDoc,
  options: { as?: boolean; force?: boolean } = {},
): Promise<boolean> {
  let path = doc.path;
  if (!path || options.as) {
    path = await backend().dialogs.saveAs(doc.path ?? doc.untitledName ?? undefined);
    if (!path) return false;
  }
  for (const participant of saveParticipants) {
    try {
      await participant(doc);
    } catch {
      // Formatting on save is best effort: the save goes ahead.
    }
  }
  beforeSave(doc);
  const text = doc.text;
  const targetChanged = !doc.path || !samePath(doc.path, path);
  try {
    const format = targetChanged && !doc.path ? await backend().fs.newFileFormat(path) : doc.format;
    const stamp = await backend().fs.writeText(
      path,
      text.toString(),
      format,
      targetChanged || doc.deleted ? null : doc.stamp,
      options.force ?? false,
    );
    if (targetChanged) {
      if (doc.path) byPath.delete(pathKey(doc.path));
      doc.path = path;
      doc.untitledName = null;
      doc.format = format;
      byPath.set(pathKey(path), doc);
      if (!doc.language) doc.setLanguage(detectLanguage(path, text.toString()));
    }
    doc.markSaved(stamp, text);
    void backend().session.removeBuffer(doc.id);
    for (const listener of savedListeners) listener(doc);
    // Saving settings.json applies it straight away.
    const { userPath, workspacePath } = useSettings.getState();
    if (samePath(path, userPath) || (workspacePath && samePath(path, workspacePath))) {
      const { applySettings } = await import('../services/settings');
      applySettings(await backend().settings.reload());
    }
    return true;
  } catch (err) {
    const kind = errorKind(err);
    if (kind === 'conflict') {
      const answer = await ask({
        title: `${doc.name} changed on disk`,
        message: 'Another program changed the file since you opened it.',
        buttons: [
          { id: 'overwrite', label: 'Overwrite', danger: true },
          { id: 'reload', label: 'Load theirs' },
          { id: 'cancel', label: 'Cancel', primary: true },
        ],
        cancelId: 'cancel',
      });
      if (answer === 'overwrite') return saveDocument(doc, { ...options, force: true });
      if (answer === 'reload') await reloadDocument(doc);
      return false;
    }
    if (kind === 'readOnly') {
      notify('error', `${doc.name} is read-only.`, {
        actions: [{ label: 'Save as…', run: () => void saveDocument(doc, { as: true }) }],
      });
      return false;
    }
    notify('error', `Couldn't save ${doc.name}.`, { detail: errorMessage(err) });
    return false;
  }
}

/** Throws away unsaved changes and loads what's on disk. */
export async function reloadDocument(doc: TextDoc): Promise<void> {
  if (!doc.path) return;
  try {
    const file = await backend().fs.readText(doc.path);
    doc.format = file.format;
    doc.readOnly = file.readOnly;
    doc.replaceContent(file.text);
    doc.markSaved(file.stamp, Text.of(file.text.split('\n')));
  } catch (err) {
    notify('error', `Couldn't reload ${doc.name}.`, { detail: errorMessage(err) });
  }
}

/** Keeps open documents in step when files are renamed or moved in the explorer. */
export function movedOnDisk(from: string, to: string) {
  for (const doc of allDocuments()) {
    if (!doc.path) continue;
    const key = pathKey(doc.path);
    const fromKey = pathKey(from);
    if (key === fromKey || key.startsWith(`${fromKey}\\`)) {
      byPath.delete(key);
      doc.path = to + doc.path.slice(from.length);
      byPath.set(pathKey(doc.path), doc);
      doc.setLanguage(detectLanguage(doc.path, ''));
    }
  }
  changed();
}

/** Reacts to changes on disk: reload clean documents, warn about dirty ones. */
export function handleDiskChanges(changes: FsChange[]) {
  for (const change of changes) {
    if (change.kind === 'rescan') {
      for (const doc of allDocuments()) void checkOnDisk(doc);
      continue;
    }
    const doc = documentForPath(change.path);
    if (doc) void checkOnDisk(doc);
  }
}

async function checkOnDisk(doc: TextDoc) {
  if (!doc.path) return;
  const info = await backend()
    .fs.stat(doc.path)
    .catch(() => null);
  if (!info) {
    if (!doc.deleted) {
      doc.deleted = true;
      changed();
    }
    return;
  }
  if (doc.stamp && info.mtime === doc.stamp.mtime && info.size === doc.stamp.size && !doc.deleted) {
    return; // Our own save.
  }
  if (!doc.dirty || doc.deleted) {
    await reloadDocument(doc);
    return;
  }
  if (doc.conflict) return;
  doc.conflict = true;
  changed();
  notify('warning', `${doc.name} changed on disk, and you have unsaved changes.`, {
    actions: [
      { label: 'Load theirs', run: () => reloadDocument(doc) },
      { label: 'Keep mine', run: () => {} },
    ],
  });
}
