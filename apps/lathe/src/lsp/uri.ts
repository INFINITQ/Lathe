// file:// URIs as VS Code writes them on Windows (file:///c%3A/Users/me/x.ts), and back.
// Servers answer with all sorts of spellings (C:, c%3A, %20 or spaces), so comparisons go
// through paths, never URI strings.

export function pathToUri(path: string): string {
  const normal = path.replace(/\\/g, '/');
  const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const drive = /^([a-zA-Z]):(\/.*)?$/.exec(normal);
  if (drive) return `file:///${drive[1]!.toLowerCase()}%3A${encode(drive[2] ?? '/')}`;
  const unc = /^\/\/([^/]+)(\/.*)?$/.exec(normal);
  if (unc) return `file://${unc[1]}${encode(unc[2] ?? '/')}`;
  return `file://${encode(normal)}`;
}

export function uriToPath(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) return null;
  const host = m[1] ?? '';
  let path: string;
  try {
    path = decodeURIComponent(m[2] ?? '/');
  } catch {
    return null;
  }
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  path = path.replace(/\//g, '\\');
  if (/^[a-zA-Z]:/.test(path)) path = path[0]!.toUpperCase() + path.slice(1);
  if (host && host !== 'localhost') return `\\\\${host}${path}`;
  return path;
}
