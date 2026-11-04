// Your own keybindings: keybindings.json in Lathe's data folder, a list in VS Code's format:
//   [ { "key": "ctrl+shift+t", "command": "terminal.new" },
//     { "key": "ctrl+,", "command": "-preferences.openSettings" } ]   ← "-" removes a binding
// It's read at start-up and again whenever you save it in Lathe. The Keyboard shortcuts editor
// changes it one entry at a time, so your comments and order stay as you left them.

import { documentForPath, onDocumentSaved, reloadDocument } from '../editor/documents';
import { backend, errorMessage } from '../lib/backend';
import { appendToList, parseJsonc, removeFromList, replaceInList } from '../lib/jsonc';
import { join, samePath } from '../lib/paths';
import {
  type Keybinding,
  type KeybindingSource,
  normalizeKey,
  setUserKeybindings,
} from './keybindings';
import { notify } from './notifications';

export const KEYBINDINGS_TEMPLATE = `// Your keybindings. They win over plugins' and Lathe's own; "-<command>" removes a binding.
// The Keyboard shortcuts editor (Ctrl+K Ctrl+S) can change this file for you.
[
]
`;

export function keybindingsPath(): string {
  return join(backend().boot().dataDir, 'keybindings.json');
}

/** The bindings in a keybindings.json, or null when it can't be read as a list at all. Entries
 * that aren't bindings are left out, and the first of them is described in `problem`. */
export function parseKeybindings(text: string): {
  bindings: Keybinding[] | null;
  problem?: string;
} {
  let raw: unknown;
  try {
    raw = text.trim() ? parseJsonc(text) : [];
  } catch (err) {
    return { bindings: null, problem: `It isn't valid JSON (${(err as Error).message}).` };
  }
  if (!Array.isArray(raw)) {
    return { bindings: null, problem: 'It should be a list: [ { "key": …, "command": … } ].' };
  }
  const bindings: Keybinding[] = [];
  let problem: string | undefined;
  raw.forEach((entry: unknown, i) => {
    const e = entry as Record<string, unknown> | null;
    if (
      !e ||
      typeof e !== 'object' ||
      typeof e.key !== 'string' ||
      typeof e.command !== 'string' ||
      !e.key.trim() ||
      !e.command
    ) {
      problem ??= `Entry ${i + 1} needs a "key" and a "command".`;
      return;
    }
    if (e.when !== undefined && typeof e.when !== 'string') {
      problem ??= `Entry ${i + 1}'s "when" should be text.`;
      return;
    }
    bindings.push({
      key: e.key,
      command: e.command,
      ...(typeof e.when === 'string' && e.when.trim() ? { when: e.when } : {}),
      ...('args' in e ? { args: e.args } : {}),
    });
  });
  return { bindings, problem };
}

let lastProblem: string | undefined;

function report(problem: string | undefined) {
  if (problem && problem !== lastProblem) {
    notify('warning', 'keybindings.json has a problem.', {
      detail: `${problem} The keybindings that could be read are in use.`,
      actions: [
        {
          label: 'Open it',
          run: async () => {
            const { executeCommand } = await import('./commands');
            await executeCommand('preferences.openKeybindingsJson');
          },
        },
      ],
    });
  }
  lastProblem = problem;
}

/** Reads keybindings.json and puts its bindings in effect (a broken file keeps the last good ones). */
export async function loadUserKeybindings(): Promise<void> {
  const path = keybindingsPath();
  let text = '';
  try {
    if (await backend().fs.stat(path)) text = (await backend().fs.readText(path)).text;
  } catch (err) {
    report(`Lathe couldn't read it: ${errorMessage(err)}`);
    return;
  }
  const { bindings, problem } = parseKeybindings(text);
  if (bindings) setUserKeybindings(bindings);
  report(problem);
}

/** Loads keybindings.json now and again each time you save it. */
export function installUserKeybindings(): () => void {
  void loadUserKeybindings();
  return onDocumentSaved((doc) => {
    if (doc.path && samePath(doc.path, keybindingsPath())) void loadUserKeybindings();
  });
}

/** Creates keybindings.json (with a short how-to) if it isn't there; returns its path. */
export async function ensureKeybindingsFile(): Promise<string> {
  const path = keybindingsPath();
  if (!(await backend().fs.stat(path))) {
    await backend().fs.writeText(path, KEYBINDINGS_TEMPLATE, null, null, false);
  }
  return path;
}

// ── Changes from the Keyboard shortcuts editor ───────────────────────────────────────────────

/** A row of the Keyboard shortcuts editor: a command and one of its bindings (if it has one). */
export interface KeybindingRow {
  command: string;
  key?: string;
  when?: string;
  source?: KeybindingSource;
}

type Entry = { key?: unknown; command?: unknown; when?: unknown };

const sameEntry = (entry: Entry, command: string, key: string | undefined, when?: string) =>
  entry.command === command &&
  typeof entry.key === 'string' &&
  normalizeKey(entry.key) === key &&
  ((typeof entry.when === 'string' ? entry.when.trim() : '') || undefined) === (when || undefined);

/** Rewrites keybindings.json with `change` and puts the result in effect. */
async function editKeybindings(
  change: (text: string, entries: Entry[]) => string,
): Promise<boolean> {
  const path = keybindingsPath();
  const open = documentForPath(path);
  if (open?.dirty) {
    notify('info', "Save or close keybindings.json first: it has changes you haven't saved.");
    return false;
  }
  try {
    const current = (await backend().fs.stat(path)) ? await backend().fs.readText(path) : null;
    const text = current?.text ?? KEYBINDINGS_TEMPLATE;
    const parsed = parseKeybindings(text);
    if (!parsed.bindings) {
      report(parsed.problem);
      return false;
    }
    const entries = text.trim() ? parseJsonc<Entry[]>(text) : [];
    const next = change(text, entries);
    await backend().fs.writeText(
      path,
      next,
      current?.format ?? null,
      current?.stamp ?? null,
      false,
    );
    const after = parseKeybindings(next);
    if (after.bindings) setUserKeybindings(after.bindings);
    if (open) await reloadDocument(open);
    return true;
  } catch (err) {
    notify('error', "Couldn't change keybindings.json.", { detail: errorMessage(err) });
    return false;
  }
}

/** Gives a row's command the key `key` (normalised, chords included). A binding of yours is
 * changed in place; one of Lathe's or a plugin's is removed and replaced, as VS Code does. */
export function changeKeybinding(row: KeybindingRow, key: string): Promise<boolean> {
  const next = normalizeKey(key);
  const binding = { key: next, command: row.command, ...(row.when ? { when: row.when } : {}) };
  return editKeybindings((text, entries) => {
    if (row.source === 'user') {
      const index = entries.findIndex((e) => sameEntry(e, row.command, row.key, row.when));
      if (index >= 0) return replaceInList(text, index, { ...entries[index], key: next });
    }
    let out = text;
    if (row.key && row.source !== 'user') {
      out = appendToList(out, {
        key: row.key,
        command: `-${row.command}`,
        ...(row.when ? { when: row.when } : {}),
      });
    }
    return appendToList(out, binding);
  });
}

/** Changes the `when` clause of a row's binding (empty for always). */
export function changeWhen(row: KeybindingRow, when: string): Promise<boolean> {
  if (!row.key) return Promise.resolve(false);
  const clause = when.trim();
  return editKeybindings((text, entries) => {
    if (row.source === 'user') {
      const index = entries.findIndex((e) => sameEntry(e, row.command, row.key, row.when));
      if (index >= 0) {
        const entry: Entry = { ...entries[index] };
        delete entry.when;
        return replaceInList(text, index, { ...entry, ...(clause ? { when: clause } : {}) });
      }
    }
    const removed = appendToList(text, {
      key: row.key,
      command: `-${row.command}`,
      ...(row.when ? { when: row.when } : {}),
    });
    return appendToList(removed, {
      key: row.key,
      command: row.command,
      ...(clause ? { when: clause } : {}),
    });
  });
}

/** Takes a row's binding away: deletes yours, or adds "-command" for Lathe's or a plugin's. */
export function removeKeybinding(row: KeybindingRow): Promise<boolean> {
  if (!row.key) return Promise.resolve(false);
  return editKeybindings((text, entries) => {
    if (row.source === 'user') {
      const index = entries.findIndex((e) => sameEntry(e, row.command, row.key, row.when));
      if (index >= 0) return removeFromList(text, index);
    }
    return appendToList(text, {
      key: row.key,
      command: `-${row.command}`,
      ...(row.when ? { when: row.when } : {}),
    });
  });
}

/** Removes every entry of yours for `command` (its own keys and its "-" removals). */
export function resetKeybindings(command: string): Promise<boolean> {
  return editKeybindings((text, entries) => {
    let out = text;
    for (let i = entries.length - 1; i >= 0; i--) {
      const c = entries[i]?.command;
      if (c === command || c === `-${command}`) out = removeFromList(out, i);
    }
    return out;
  });
}

/** Adds bindings (an import) that keybindings.json doesn't have yet; resolves how many. */
export async function addKeybindings(bindings: Keybinding[]): Promise<number> {
  let added = 0;
  const ok = await editKeybindings((text, entries) => {
    let out = text;
    const seen = new Set<string>();
    for (const binding of bindings) {
      const key = normalizeKey(binding.key);
      const id = JSON.stringify([key, binding.command, binding.when ?? '']);
      if (seen.has(id) || entries.some((e) => sameEntry(e, binding.command, key, binding.when))) {
        continue;
      }
      seen.add(id);
      out = appendToList(out, { ...binding, key });
      added++;
    }
    return out;
  });
  return ok ? added : 0;
}
