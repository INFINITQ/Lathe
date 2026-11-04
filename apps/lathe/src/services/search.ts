// The Search view's state: the query, results streaming in from Rust (lathe_core::search), and
// replacing. Open files with unsaved changes are searched as they are in the editor; replacing
// edits open documents in memory (saving the ones that were saved) and has Rust rewrite the
// other files, keeping their encoding, BOM and line endings.

import { create } from 'zustand';
import { dirtyDocuments, documentForPath, saveDocument } from '../editor/documents';
import {
  type FileMatches,
  type SearchMatch,
  type SearchQuery,
  backend,
  errorMessage,
} from '../lib/backend';
import { basename, isUnder, pathKey } from '../lib/paths';
import { openPath } from '../workbench/editors/store';
import { useWorkspace } from '../workbench/workspaceStore';
import { ask } from './dialogs';
import { notify } from './notifications';
import { getSetting } from './settings';

export interface SearchSummary {
  files: number;
  matches: number;
  limitHit: boolean;
  elapsedMs: number;
  unreadable: number;
  firstUnreadable: string | null;
}

export interface SearchState {
  pattern: string;
  replacement: string;
  replaceOpen: boolean;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  /** Apply files.exclude, search.exclude and .gitignore (VS Code's book-icon toggle). */
  useExcludeSettings: boolean;
  detailsOpen: boolean;
  running: boolean;
  files: FileMatches[];
  /** Collapsed files, by path key. */
  collapsed: Record<string, true>;
  summary: SearchSummary | null;
  error: string | null;
  /** The match F4 last went to: [file path key, index]. */
  cursor: [string, number] | null;
  /** Bumped to ask the view to focus (and select) the search box. */
  focusRequest: number;
}

export const useSearch = create<SearchState>(() => ({
  pattern: '',
  replacement: '',
  replaceOpen: false,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  useExcludeSettings: true,
  detailsOpen: false,
  running: false,
  files: [],
  collapsed: {},
  summary: null,
  error: null,
  cursor: null,
  focusRequest: 0,
}));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byPath = (a: FileMatches, b: FileMatches) => collator.compare(a.path, b.path);

function globs(text: string): string[] {
  return text
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

function enabledGlobs(setting: Record<string, boolean>): string[] {
  return Object.entries(setting)
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
}

/** The query the Search view describes right now. */
export function currentQuery(state: SearchState = useSearch.getState()): SearchQuery {
  const exclude = globs(state.exclude);
  if (state.useExcludeSettings) {
    exclude.push(...enabledGlobs(getSetting('files.exclude')));
    exclude.push(...enabledGlobs(getSetting('search.exclude')));
  }
  return {
    pattern: state.pattern,
    isRegex: state.isRegex,
    matchCase: state.matchCase,
    wholeWord: state.wholeWord,
    include: globs(state.include),
    exclude,
    useIgnoreFiles: state.useExcludeSettings && getSetting('search.useIgnoreFiles'),
    maxResults: getSetting('search.maxResults'),
  };
}

/** What the last search looked for, so remounting the view doesn't search again. */
let lastKey = '';
let generation = 0;

export function queryKey(state: SearchState = useSearch.getState()): string {
  return JSON.stringify([currentQuery(state), useWorkspace.getState().root]);
}

/**
 * Searches the open folder. Results stream into the list as they're found; with `keep`, the
 * old results stay until the new ones are complete (after a replace, so the list doesn't
 * flicker).
 */
export async function runSearch(options: { keep?: boolean } = {}): Promise<void> {
  const state = useSearch.getState();
  const root = useWorkspace.getState().root;
  const gen = ++generation;
  lastKey = queryKey(state);
  if (!state.pattern || !root) {
    void backend().search.cancel();
    useSearch.setState({ running: false, files: [], summary: null, error: null, cursor: null });
    return;
  }
  const unsaved = dirtyDocuments()
    .filter((d) => d.path && isUnder(d.path, root))
    .map((d): [string, string] => [d.path!, d.text.toString()]);
  let found: FileMatches[] = [];
  useSearch.setState(
    options.keep
      ? { running: true, error: null }
      : { running: true, error: null, files: [], summary: null, cursor: null },
  );
  try {
    await backend().search.start(currentQuery(state), unsaved, (event) => {
      if (gen !== generation) return;
      if (event.type === 'files') {
        found = [...found, ...event.files].sort(byPath);
        if (!options.keep) useSearch.setState({ files: found });
        return;
      }
      useSearch.setState({
        running: false,
        files: found,
        error: event.error,
        summary: {
          files: event.files,
          matches: event.matches,
          limitHit: event.limitHit,
          elapsedMs: event.elapsedMs,
          unreadable: event.unreadable,
          firstUnreadable: event.firstUnreadable,
        },
      });
    });
  } catch (err) {
    if (gen === generation) useSearch.setState({ running: false, error: errorMessage(err) });
  }
}

/** Searches if the query changed since the last search (typing, toggles). */
export function searchIfChanged() {
  if (queryKey() !== lastKey) void runSearch();
}

export function clearSearch() {
  generation++;
  lastKey = '';
  void backend().search.cancel();
  useSearch.setState({
    pattern: '',
    running: false,
    files: [],
    summary: null,
    error: null,
    cursor: null,
  });
}

export function matchCount(files: FileMatches[] = useSearch.getState().files): number {
  return files.reduce((n, f) => n + f.matches.length, 0);
}

/** Opens a match in the editor with it selected. */
export function openMatch(
  path: string,
  match: SearchMatch,
  options: { preserveFocus?: boolean; side?: boolean } = {},
) {
  void openPath(path, {
    preview: true,
    group: options.side ? 'side' : undefined,
    preserveFocus: options.preserveFocus,
    selection: {
      line: match.line,
      column: match.column + 1,
      endLine: match.endLine,
      endColumn: match.endColumn + 1,
    },
  });
}

/** F4 and Shift+F4: the next or previous match, across files. */
export function goToMatch(step: 1 | -1) {
  const { files, cursor } = useSearch.getState();
  const flat = files.flatMap((f) => f.matches.map((m, i) => ({ file: f, match: m, i })));
  if (!flat.length) return;
  let at = cursor
    ? flat.findIndex((e) => pathKey(e.file.path) === cursor[0] && e.i === cursor[1])
    : -1;
  at = at < 0 ? (step > 0 ? 0 : flat.length - 1) : (at + step + flat.length) % flat.length;
  const entry = flat[at]!;
  useSearch.setState({ cursor: [pathKey(entry.file.path), entry.i] });
  openMatch(entry.file.path, entry.match);
}

export function dismissFile(path: string) {
  const key = pathKey(path);
  useSearch.setState((s) => ({ files: s.files.filter((f) => pathKey(f.path) !== key) }));
}

export function dismissMatch(path: string, match: SearchMatch) {
  const key = pathKey(path);
  useSearch.setState((s) => ({
    files: s.files
      .map((f) =>
        pathKey(f.path) === key ? { ...f, matches: f.matches.filter((m) => m !== match) } : f,
      )
      .filter((f) => f.matches.length > 0),
  }));
}

/** What a match becomes, for the preview (JavaScript's regex flavour; Rust does the real one). */
export function previewReplacement(text: string, state: SearchState): string {
  if (!state.isRegex) return state.replacement;
  try {
    const re = new RegExp(state.pattern, state.matchCase ? 'u' : 'iu');
    return text.replace(re, state.replacement.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  } catch {
    return state.replacement;
  }
}

/** Replaces in open documents (saving the ones that had no unsaved changes) and on disk. */
async function replaceIn(paths: string[]): Promise<{ replaced: number; failed: string[] }> {
  const state = useSearch.getState();
  const query = currentQuery(state);
  const onDisk: string[] = [];
  let replaced = 0;
  const failed: string[] = [];
  for (const path of paths) {
    const doc = documentForPath(path);
    if (!doc) {
      onDisk.push(path);
      continue;
    }
    try {
      const wasDirty = doc.dirty;
      const edits = await backend().search.edits(query, state.replacement, doc.text.toString());
      doc.applyEdits(edits);
      replaced += edits.length;
      if (!wasDirty && edits.length) await saveDocument(doc);
    } catch (err) {
      failed.push(`${basename(path)}: ${errorMessage(err)}`);
    }
  }
  if (onDisk.length) {
    for (const result of await backend().search.replaceFiles(query, state.replacement, onDisk)) {
      replaced += result.count;
      if (result.error) failed.push(`${basename(result.path)}: ${result.error.message}`);
    }
  }
  return { replaced, failed };
}

function reportReplace(result: { replaced: number; failed: string[] }) {
  if (result.failed.length) {
    notify('error', `Some files couldn't be changed.`, { detail: result.failed.join('\n') });
  }
}

export async function replaceAll() {
  const state = useSearch.getState();
  const files = state.files;
  const count = matchCount(files);
  if (!count) return;
  const answer = await ask({
    title: `Replace ${count} ${count === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}?`,
    message: state.replacement
      ? `Each one becomes "${state.replacement}".`
      : 'Each one is deleted (the replacement is empty).',
    buttons: [
      { id: 'replace', label: 'Replace', primary: true },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  });
  if (answer !== 'replace') return;
  const result = await replaceIn(files.map((f) => f.path));
  reportReplace(result);
  notify('info', `Replaced ${result.replaced} ${result.replaced === 1 ? 'match' : 'matches'}.`);
  await runSearch({ keep: true });
}

export async function replaceInFile(path: string) {
  reportReplace(await replaceIn([path]));
  dismissFile(path);
  void runSearch({ keep: true });
}

export async function replaceMatch(path: string, match: SearchMatch) {
  const state = useSearch.getState();
  const query = currentQuery(state);
  try {
    const doc = documentForPath(path);
    if (doc) {
      const line = doc.text.line(Math.min(match.line, doc.text.lines));
      const edits = await backend().search.edits(
        query,
        state.replacement,
        doc.text.toString(),
        line.from + match.column,
      );
      doc.applyEdits(edits);
    } else {
      await backend().search.replaceAt(query, state.replacement, path, match.line, match.column);
    }
  } catch (err) {
    notify('error', `Couldn't replace in ${basename(path)}.`, { detail: errorMessage(err) });
    return;
  }
  dismissMatch(path, match);
  void runSearch({ keep: true });
}

/** Ctrl+Shift+F / Ctrl+Shift+H: the search box, filled with the selection if there is one. */
export function focusSearch(options: { replace?: boolean; seed?: string; include?: string } = {}) {
  useSearch.setState((s) => ({
    pattern: options.seed && !options.seed.includes('\n') ? options.seed : s.pattern,
    replaceOpen: options.replace ? true : s.replaceOpen,
    include: options.include ?? s.include,
    detailsOpen: options.include ? true : s.detailsOpen,
    focusRequest: s.focusRequest + 1,
  }));
}
