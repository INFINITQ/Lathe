// Windows paths as Lathe shows and compares them. Rust hands out paths with `\`; both
// separators are accepted everywhere, and comparisons ignore case, as Windows does.

export const SEP = '\\';

function trimTrailing(path: string): string {
  // Keep the root of a drive ("C:\") intact.
  if (/^[a-zA-Z]:[\\/]?$/.test(path)) return `${path.slice(0, 2)}\\`;
  return path.replace(/[\\/]+$/, '');
}

/** The last part of a path: `C:\a\b.txt` → `b.txt`. */
export function basename(path: string): string {
  const trimmed = trimTrailing(path);
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed;
}

/** The folder a path is in: `C:\a\b.txt` → `C:\a`; a drive root stays itself. */
export function dirname(path: string): string {
  const trimmed = trimTrailing(path);
  if (/^[a-zA-Z]:\\$/.test(trimmed)) return trimmed;
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (at < 0) return '';
  const parent = trimmed.slice(0, at);
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

/** Joins path parts with `\`, accepting `/` in the parts. */
export function join(...parts: string[]): string {
  const cleaned = parts
    .filter((p) => p !== '')
    .map((p, i) => {
      const text = p.replaceAll('/', '\\');
      return i === 0 ? text.replace(/\\+$/, '') : text.replace(/^\\+|\\+$/g, '');
    });
  const joined = cleaned.join('\\');
  return /^[a-zA-Z]:$/.test(joined) ? `${joined}\\` : joined;
}

/** The extension with its dot, lower-cased: `Main.PY` → `.py`. Empty for none or dotfiles. */
export function extname(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at).toLowerCase() : '';
}

/** A key for maps and sets: same for every spelling of the same path. */
export function pathKey(path: string): string {
  return trimTrailing(path.replaceAll('/', '\\')).toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `path` is `root` or inside it. */
export function isUnder(path: string, root: string): boolean {
  const p = pathKey(path);
  const r = pathKey(root);
  return p === r || p.startsWith(r.endsWith('\\') ? r : `${r}\\`);
}

/** `path` relative to `root` with `/` (as shown in quick open and tab tooltips). */
export function relative(root: string, path: string): string {
  if (!isUnder(path, root)) return path;
  const rest = path.slice(trimTrailing(root).length).replace(/^[\\/]+/, '');
  return rest.replaceAll('\\', '/');
}

/** True for full paths such as `C:\x` or `\\server\share\x`. */
export function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Resolves `path` against `base` unless it's already absolute; `.` and `..` are folded. */
export function resolve(base: string, path: string): string {
  const full = isAbsolute(path) ? path : join(base, path);
  const [head, ...rest] = full.replaceAll('/', '\\').split('\\');
  const out: string[] = [];
  for (const part of rest) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return join(head ?? '', ...out);
}
