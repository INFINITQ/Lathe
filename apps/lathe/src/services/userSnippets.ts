// Your own snippets, in VS Code's format, in the snippets folder of Lathe's data folder:
// "<language>.json" for one language ("python.json"), or "<name>.code-snippets" for any
// (each snippet's "scope": "python,javascript" narrows it). Loaded at start-up and again when
// you save one of them in Lathe.

import { onDocumentSaved } from '../editor/documents';
import { backend, errorMessage } from '../lib/backend';
import { parseJsonc } from '../lib/jsonc';
import { basename, dirname, join, samePath } from '../lib/paths';
import { removeSnippets, setSnippets } from '../plugins/providers';
import { notify } from './notifications';

type SnippetFile = Parameters<typeof setSnippets>[2];

const OWNER = 'user:';
let loaded: string[] = [];

export function snippetsDir(): string {
  return join(backend().boot().dataDir, 'snippets');
}

/** Reads every snippets file and puts its snippets in the completions. */
export async function loadUserSnippets(): Promise<void> {
  for (const owner of loaded) removeSnippets(owner);
  loaded = [];
  const dir = snippetsDir();
  let entries: { name: string; dir: boolean }[];
  try {
    entries = (await backend().fs.stat(dir)) ? await backend().fs.readDir(dir) : [];
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^(.+)\.(json|code-snippets)$/i.exec(entry.name);
    if (entry.dir || !match) continue;
    const owner = `${OWNER}${entry.name}`;
    let file: SnippetFile;
    try {
      file = parseJsonc<SnippetFile>((await backend().fs.readText(join(dir, entry.name))).text);
      if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
    } catch (err) {
      notify('warning', `Snippets in ${entry.name} couldn't be read.`, {
        detail: errorMessage(err),
      });
      continue;
    }
    if (match[2]!.toLowerCase() === 'json') {
      setSnippets(owner, match[1]!, file);
    } else {
      // A global file: each snippet goes to the languages in its "scope" (or to every one).
      const byLanguage = new Map<string, SnippetFile>();
      for (const [name, snippet] of Object.entries(file)) {
        const scope = (snippet as { scope?: unknown }).scope;
        const languages =
          typeof scope === 'string' && scope.trim()
            ? scope
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : ['*'];
        for (const language of languages) {
          const list = byLanguage.get(language) ?? {};
          list[name] = snippet;
          byLanguage.set(language, list);
        }
      }
      for (const [language, list] of byLanguage) setSnippets(owner, language, list);
    }
    loaded.push(owner);
  }
}

/** Loads your snippets now and again whenever you save a file in the snippets folder. */
export function installUserSnippets(): () => void {
  void loadUserSnippets();
  return onDocumentSaved((doc) => {
    if (doc.path && samePath(dirname(doc.path), snippetsDir())) void loadUserSnippets();
  });
}

const TEMPLATE = (language: string) => `{
  // Snippets for ${language}. Each has a prefix you type, and the body it becomes:
  // $1, $2 are where Tab goes next, \${1:text} has a placeholder, $0 is where it ends.
  // "Print": {
  //   "prefix": "log",
  //   "body": ["console.log($1);", "$0"],
  //   "description": "Log to the console"
  // }
}
`;

/** The snippets file for a language (or a global one), created with a short how-to if new. */
export async function snippetsFileFor(language: string): Promise<string> {
  const dir = snippetsDir();
  const name = language === '*' ? 'global.code-snippets' : `${basename(language)}.json`;
  const path = join(dir, name);
  if (!(await backend().fs.stat(path))) {
    if (!(await backend().fs.stat(dir))) await backend().fs.createDir(dir);
    await backend().fs.writeText(
      path,
      TEMPLATE(language === '*' ? 'any language' : language),
      null,
      null,
      false,
    );
  }
  return path;
}
