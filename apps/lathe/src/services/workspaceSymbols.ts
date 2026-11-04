// "#" in quick open: symbols across the folder. Until language servers arrive (M4) this asks
// the search engine for definition keywords (def, class, fn, struct…) followed by a name that
// fuzzily matches what you typed, so it finds most definitions in most languages. C and C++
// functions have no keyword, so they wait for clangd.

import type { SymbolKind } from '../editor/symbols';
import { type FileMatches, backend } from '../lib/backend';
import { getSetting } from './settings';

export interface WorkspaceSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  /** 0-based UTF-16 column of the name. */
  column: number;
}

const KEYWORDS: Record<string, SymbolKind> = {
  def: 'function',
  fn: 'function',
  func: 'function',
  function: 'function',
  class: 'class',
  record: 'class',
  object: 'class',
  struct: 'struct',
  enum: 'enum',
  trait: 'interface',
  interface: 'interface',
  protocol: 'interface',
  type: 'type',
  typealias: 'type',
  mod: 'module',
  module: 'module',
  namespace: 'namespace',
  impl: 'namespace',
};

const KEYWORD = Object.keys(KEYWORDS).join('|');

/** The name pattern for a query: its letters in order, anything in between ("gtf" → g…t…f). */
export function namePattern(query: string): string | null {
  const letters = [...query].filter((c) => /[\w$]/.test(c));
  if (!letters.length) return null;
  const escaped = letters.map((c) => (c === '$' ? '\\$' : c));
  return `[\\w$]*${escaped.join('[\\w$]*')}[\\w$]*`;
}

export function symbolRegex(query: string): string | null {
  const name = namePattern(query);
  if (!name) return null;
  return `\\b(?:${KEYWORD})\\s+\\*?(${name})`;
}

/** Reads the symbols out of search results. */
export function symbolsFrom(files: FileMatches[], query: string): WorkspaceSymbol[] {
  const name = namePattern(query);
  if (!name) return [];
  const re = new RegExp(`\\b(${KEYWORD})\\s+\\*?(${name})`, 'i');
  const out: WorkspaceSymbol[] = [];
  for (const file of files) {
    for (const match of file.matches) {
      const found = re.exec(match.preview.slice(match.previewStart));
      if (!found) continue;
      const keyword = found[1]!.toLowerCase();
      const symbol = found[2]!;
      const offset = found[0].length - symbol.length;
      out.push({
        name: symbol,
        kind: KEYWORDS[keyword] ?? 'function',
        path: file.path,
        line: match.line,
        column: match.column + (found.index ?? 0) + offset,
      });
    }
  }
  return out;
}

/** Other sources of workspace symbols (running language servers). */
type SymbolProvider = (query: string) => Promise<WorkspaceSymbol[]>;
const providers: SymbolProvider[] = [];
export function registerSymbolProvider(provider: SymbolProvider) {
  providers.push(provider);
}

let generation = 0;

/** Finds symbols matching `query` in the open folder: language servers' and the search's. */
export async function findWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
  const [found, ...fromServers] = await Promise.all([
    searchSymbols(query),
    ...providers.map((p) => p(query).catch(() => [])),
  ]);
  const seen = new Set<string>();
  const all: WorkspaceSymbol[] = [];
  // Servers first: they know kinds and C/C++ functions.
  for (const symbol of [...fromServers.flat(), ...(found ?? [])]) {
    const key = `${symbol.path.toLowerCase()}:${symbol.line}:${symbol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(symbol);
  }
  return all;
}

function searchSymbols(query: string): Promise<WorkspaceSymbol[]> {
  const pattern = symbolRegex(query);
  const gen = ++generation;
  if (!pattern) return Promise.resolve([]);
  const exclude = [
    ...Object.entries(getSetting('files.exclude')),
    ...Object.entries(getSetting('search.exclude')),
  ]
    .filter(([, on]) => on === true)
    .map(([glob]) => glob);
  return new Promise((resolve, reject) => {
    const files: FileMatches[] = [];
    backend()
      .search.start(
        {
          pattern,
          isRegex: true,
          matchCase: false,
          wholeWord: false,
          include: [],
          exclude,
          useIgnoreFiles: true,
          maxResults: 500,
        },
        [],
        (event) => {
          if (gen !== generation) return resolve([]);
          if (event.type === 'files') files.push(...event.files);
          else resolve(symbolsFrom(files, query));
        },
        'symbols',
      )
      .catch(reject);
  });
}
