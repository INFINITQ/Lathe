// The LSP client's view of Lathe's documents. One file per document, however many editors show
// it (split editors share a document). A file stays open in the server while a tab shows it,
// even when its editor isn't on screen (only the active tab has one), as in VS Code; servers
// like pyright only rename across open files. Files a server mentions that aren't open
// (references, definitions) are loaded or opened on request.

import { LSPPlugin, Workspace, type WorkspaceFile } from '@codemirror/lsp-client';
import { ChangeSet, type Text, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { documentForPath, getDocument, openDocument } from '../editor/documents';
import { openPath, useEditors } from '../workbench/editors/store';
import { uriToPath } from './uri';

type WorkspaceFileUpdate = ReturnType<Workspace['syncFiles']>[number];

class LatheFile implements WorkspaceFile {
  readonly views = new Set<EditorView>();

  constructor(
    readonly uri: string,
    readonly languageId: string,
    readonly docId: string | null,
    public version: number,
    public doc: Text,
  ) {}

  getView(main?: EditorView): EditorView | null {
    if (main && this.views.has(main)) return main;
    for (const view of this.views) if (view.dom.isConnected) return view;
    return this.views.values().next().value ?? null;
  }
}

/** A file loaded only to read it (a reference's line), not open in the server. */
class LoadedFile implements WorkspaceFile {
  readonly version = 0;
  constructor(
    readonly uri: string,
    readonly languageId: string,
    readonly doc: Text,
  ) {}
  getView(): EditorView | null {
    return null;
  }
}

/** Waits (briefly) for an editor of the document to be on screen. */
async function viewOf(docId: string): Promise<EditorView | null> {
  for (let i = 0; i < 60; i++) {
    const doc = getDocument(docId);
    for (const view of doc?.views ?? []) if (view.dom.isConnected) return view;
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return null;
}

function isInTab(docId: string | null): boolean {
  if (!docId) return false;
  return useEditors.getState().groups.some((g) => g.tabs.some((t) => t.docId === docId));
}

/** The change from `prev` to `next`, as one replacement of the part that differs. */
function difference(prev: Text, next: Text): ChangeSet {
  const a = prev.toString();
  const b = next.toString();
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return ChangeSet.of([{ from: start, to: endA, insert: b.slice(start, endB) }], a.length);
}

export class LatheWorkspace extends Workspace {
  files: LatheFile[] = [];

  constructor(client: ConstructorParameters<typeof Workspace>[0]) {
    super(client);
    // Closing a tab closes its file in the server.
    useEditors.subscribe(() => this.prune());
  }

  override getFile(uri: string): LatheFile | null {
    const path = uriToPath(uri)?.toLowerCase();
    return (
      this.files.find((f) => f.uri === uri) ??
      (path ? this.files.find((f) => uriToPath(f.uri)?.toLowerCase() === path) : undefined) ??
      null
    );
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const updates: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const view = file.getView();
      const plugin = view && LSPPlugin.get(view);
      if (view && plugin) {
        const changes = plugin.unsyncedChanges;
        if (changes.empty) continue;
        updates.push({ file, prevDoc: file.doc, changes });
        file.doc = view.state.doc;
        file.version++;
        // Every editor of the file saw the same changes.
        for (const other of file.views) LSPPlugin.get(other)?.clear();
        continue;
      }
      // No editor on screen (a background tab): the document may still change (a rename).
      const text = file.docId ? getDocument(file.docId)?.text : undefined;
      if (!text || text === file.doc || text.eq(file.doc)) continue;
      updates.push({ file, prevDoc: file.doc, changes: difference(file.doc, text) });
      file.doc = text;
      file.version++;
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const existing = this.getFile(uri);
    if (existing) {
      // Bring the server up to date first, so the new editor starts from the synced text.
      this.client.sync();
      existing.views.add(view);
      return;
    }
    const path = uriToPath(uri);
    const docId = path ? (documentForPath(path)?.id ?? null) : null;
    const file = new LatheFile(uri, languageId, docId, 0, view.state.doc);
    file.views.add(view);
    this.files.push(file);
    this.client.didOpen(file);
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri);
    if (!file) return;
    file.views.delete(view);
    this.prune();
  }

  /** Closes files that no editor shows and no tab holds. */
  private prune() {
    const closing = this.files.filter((f) => !f.views.size && !isInTab(f.docId));
    if (!closing.length) return;
    this.client.sync();
    this.files = this.files.filter((f) => !closing.includes(f));
    for (const file of closing) this.client.didClose(file.uri);
  }

  override async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    const path = uriToPath(uri);
    if (!path) return null;
    try {
      const doc = documentForPath(path) ?? (await openDocument(path));
      return new LoadedFile(uri, doc.languageId, doc.text);
    } catch {
      return null;
    }
  }

  override updateFile(uri: string, update: TransactionSpec): void {
    const view = this.getFile(uri)?.getView();
    if (view) view.dispatch(update);
  }

  override async displayFile(uri: string): Promise<EditorView | null> {
    const path = uriToPath(uri);
    if (!path) return null;
    await openPath(path);
    const doc = documentForPath(path);
    return doc ? viewOf(doc.id) : null;
  }
}
