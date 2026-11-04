// JSON with comments and trailing commas, as VS Code's tasks.json and launch.json are written.

/** Removes comments and trailing commas, leaving strings alone. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma whose next non-space character closes an object or array.
  let result = '';
  for (let j = 0; j < out.length; j++) {
    const c = out[j]!;
    if (c === '"') {
      const start = j++;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      result += out.slice(start, j + 1);
      continue;
    }
    if (c === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k]!)) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    result += c;
  }
  return result;
}

/** Parses JSONC; throws SyntaxError like JSON.parse. */
export function parseJsonc<T = unknown>(text: string): T {
  return JSON.parse(stripJsonc(text)) as T;
}

// ── Editing a JSONC list in place ────────────────────────────────────────────────────────────
// keybindings.json is a list you may have commented. These change one entry and leave every
// other character (comments, spacing, your order) as it was.

interface Span {
  start: number;
  end: number;
}

interface ListShape {
  open: number;
  close: number;
  items: Span[];
}

/** Moves past a comment starting at `i`, or returns `i` when there's none. */
function afterComment(text: string, i: number): number {
  if (text[i] === '/' && text[i + 1] === '/') {
    while (i < text.length && text[i] !== '\n') i++;
    return i;
  }
  if (text[i] === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end < 0 ? text.length : end + 2;
  }
  return i;
}

/** Moves past spaces and comments. */
function afterBlank(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    const next = afterComment(text, i);
    if (next === i) return i;
    i = next;
  }
}

/** Where the top-level list and each of its entries are, or null when the text isn't one list. */
export function listShape(text: string): ListShape | null {
  const n = text.length;
  let i = afterBlank(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
  if (text[i] !== '[') return null;
  const open = i++;
  const items: Span[] = [];
  let current: Span | null = null;
  let depth = 1;
  while (i < n) {
    const skipped = afterBlank(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = text[i]!;
    if (depth === 1 && (c === ',' || c === ']')) {
      if (current) items.push(current);
      current = null;
      if (c === ']') {
        return afterBlank(text, i + 1) === n ? { open, close: i, items } : null;
      }
      i++;
      continue;
    }
    current ??= { start: i, end: i };
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
    } else {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      i++;
    }
    current.end = Math.min(i, n);
  }
  return null;
}

/** The indentation of the list's first entry (two spaces for an empty list). */
function entryIndent(text: string, shape: ListShape): string {
  const first = shape.items[0];
  if (!first) return '  ';
  const lineStart = text.lastIndexOf('\n', first.start - 1) + 1;
  const before = text.slice(lineStart, first.start);
  return /^[ \t]*$/.test(before) ? before : '  ';
}

function requireList(text: string): ListShape {
  const shape = listShape(text);
  if (!shape) throw new SyntaxError("The file isn't a list ([ … ]).");
  return shape;
}

/** Adds `value` as the last entry. An empty file becomes a list holding it. */
export function appendToList(text: string, value: unknown): string {
  const json = (indent: string) => JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  if (!text.trim()) return `[\n  ${json('  ')}\n]\n`;
  const shape = requireList(text);
  const indent = entryIndent(text, shape);
  const last = shape.items.at(-1);
  if (!last) {
    return `${text.slice(0, shape.open + 1)}\n${indent}${json(indent)}\n${text.slice(shape.open + 1).replace(/^\s*\]/, ']')}`;
  }
  return `${text.slice(0, last.end)},\n${indent}${json(indent)}${text.slice(last.end)}`;
}

/** Replaces entry `index` with `value`. */
export function replaceInList(text: string, index: number, value: unknown): string {
  const shape = requireList(text);
  const item = shape.items[index];
  if (!item) throw new RangeError(`There's no entry ${index}.`);
  const indent = entryIndent(text, shape);
  const json = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  return text.slice(0, item.start) + json + text.slice(item.end);
}

/** Removes entry `index` with its comma (and its line, when it had one to itself). */
export function removeFromList(text: string, index: number): string {
  const shape = requireList(text);
  const item = shape.items[index];
  if (!item) throw new RangeError(`There's no entry ${index}.`);
  const comma = afterBlank(text, item.end);
  if (text[comma] === ',') {
    // Cut from the start of its line (when only spaces come before it) to past the comma and
    // the rest of that line.
    const lineStart = text.lastIndexOf('\n', item.start - 1) + 1;
    const from = /^[ \t]*$/.test(text.slice(lineStart, item.start)) ? lineStart : item.start;
    let to = comma + 1;
    const lineEnd = text.indexOf('\n', to);
    if (lineEnd >= 0 && /^[ \t\r]*$/.test(text.slice(to, lineEnd))) to = lineEnd + 1;
    return text.slice(0, from) + text.slice(to);
  }
  // The last entry, with no comma after it: take the comma before it instead.
  const previous = shape.items[index - 1];
  if (previous) {
    const before = afterBlank(text, previous.end);
    return text.slice(0, before) + text.slice(item.end);
  }
  return text.slice(0, shape.open + 1) + text.slice(item.end);
}
