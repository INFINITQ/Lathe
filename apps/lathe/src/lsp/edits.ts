// Workspace edits from language servers (renames, quick fixes, refactorings). Open documents
// change in memory; other files are loaded, changed and saved in their own format. Files that
// had no unsaved changes are saved afterwards, as VS Code's files.refactoring.autoSave does.

import type { Text } from '@codemirror/state';
import type * as lsp from 'vscode-languageserver-protocol';
import {
  documentForPath,
  movedOnDisk,
  openDocument,
  releaseDocument,
  saveDocument,
} from '../editor/documents';
import { backend, errorMessage } from '../lib/backend';
import { openPath, useEditors } from '../workbench/editors/store';
import { uriToPath } from './uri';

/** An LSP position (UTF-16 line and character) as an offset into `doc`. */
export function offsetOf(doc: Text, position: lsp.Position): number {
  if (position.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(1, position.line + 1));
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

/** An offset as an LSP position. */
export function positionOf(doc: Text, offset: number): lsp.Position {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  return { line: line.number - 1, character: offset - line.from };
}

function isTabOpen(docId: string): boolean {
  return useEditors.getState().groups.some((g) => g.tabs.some((t) => t.docId === docId));
}

export interface EditResult {
  applied: boolean;
  /** Files that changed. */
  files: number;
  failure?: string;
}

/** Applies text edits to one file (by path). */
export async function editFile(path: string, edits: readonly lsp.TextEdit[]): Promise<void> {
  const existing = documentForPath(path);
  const doc = existing ?? (await openDocument(path));
  const wasDirty = doc.dirty;
  const changes = edits
    .map((edit) => ({
      from: offsetOf(doc.text, edit.range.start),
      to: offsetOf(doc.text, edit.range.end),
      insert: edit.newText,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  doc.applyEdits(changes);
  if (wasDirty) return;
  const saved = await saveDocument(doc);
  if (saved && !existing && !isTabOpen(doc.id)) {
    releaseDocument(doc);
  } else if (!saved && !isTabOpen(doc.id)) {
    // Couldn't save: show it, so the change isn't lost out of sight.
    await openPath(path);
  }
}

export async function applyWorkspaceEdit(edit: lsp.WorkspaceEdit): Promise<EditResult> {
  const byFile = new Map<string, lsp.TextEdit[]>();
  const add = (uri: string, edits: readonly (lsp.TextEdit | lsp.AnnotatedTextEdit)[]) => {
    const list = byFile.get(uri) ?? [];
    list.push(...edits);
    byFile.set(uri, list);
  };
  try {
    if (edit.documentChanges) {
      for (const change of edit.documentChanges) {
        if ('kind' in change) {
          await applyResourceOperation(change);
        } else {
          add(change.textDocument.uri, change.edits as lsp.TextEdit[]);
        }
      }
    } else if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    }
    let files = 0;
    for (const [uri, edits] of byFile) {
      const path = uriToPath(uri);
      if (!path || !edits.length) continue;
      await editFile(path, edits);
      files++;
    }
    return { applied: true, files };
  } catch (err) {
    return { applied: false, files: 0, failure: errorMessage(err) };
  }
}

async function applyResourceOperation(change: lsp.CreateFile | lsp.RenameFile | lsp.DeleteFile) {
  const fs = backend().fs;
  if (change.kind === 'create') {
    const path = uriToPath(change.uri);
    if (!path) return;
    const exists = await fs.stat(path);
    if (exists && !change.options?.overwrite) return;
    await fs.createFile(path);
  } else if (change.kind === 'rename') {
    const from = uriToPath(change.oldUri);
    const to = uriToPath(change.newUri);
    if (!from || !to) return;
    await fs.rename(from, to);
    movedOnDisk(from, to);
  } else {
    const path = uriToPath(change.uri);
    if (path) await fs.delete([path], true);
  }
}

/** "Renamed in 3 files", for a toast. */
export function describeEdit(result: EditResult, what: string): string {
  if (!result.applied) return `Couldn't ${what}: ${result.failure ?? 'the edit failed'}.`;
  return result.files === 1 ? `${what} in 1 file.` : `${what} in ${result.files} files.`;
}
