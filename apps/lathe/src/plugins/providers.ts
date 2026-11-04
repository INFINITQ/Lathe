// Completions and hovers from plugins, and snippets they declare (in VS Code's snippet format),
// for every editor. A plugin's answer must come within a moment, or the editor goes on without it.

import {
  type Completion,
  type CompletionSource,
  snippetCompletion,
} from '@codemirror/autocomplete';
import { language as languageFacet } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { hoverTooltip } from '@codemirror/view';
import { addEditorExtensions } from '../editor/setup';
import { basename } from '../lib/paths';
import { getActiveDoc } from '../editor/active';
import type { PluginHost } from './host';

interface Provider {
  host: PluginHost;
  id: string;
  kind: 'completion' | 'hover';
  /** A language id, or "*". */
  language: string;
}

const providers: Provider[] = [];

export function registerProvider(host: PluginHost, provider: Omit<Provider, 'host'>) {
  providers.push({ ...provider, host });
}

export function unregisterProvider(host: PluginHost, id: string) {
  const at = providers.findIndex((p) => p.host === host && p.id === id);
  if (at >= 0) providers.splice(at, 1);
}

export function forgetProviders(host: PluginHost) {
  for (let i = providers.length - 1; i >= 0; i--)
    if (providers[i]!.host === host) providers.splice(i, 1);
}

/** The editor's language, as Lathe names languages ("python", "typescript"…). */
function languageOf(state: EditorState): string {
  const doc = getActiveDoc();
  if (doc && doc.views.size && [...doc.views].some((v) => v.state === state)) return doc.languageId;
  return state.facet(languageFacet)?.name.toLowerCase() ?? 'plaintext';
}

const matches = (wanted: string, language: string) => wanted === '*' || wanted === language;

interface PluginCompletion {
  label?: unknown;
  detail?: unknown;
  insertText?: unknown;
  kind?: unknown;
}

const pluginCompletions: CompletionSource = async (context) => {
  const language = languageOf(context.state);
  const mine = providers.filter((p) => p.kind === 'completion' && matches(p.language, language));
  if (!mine.length) return null;
  const word = context.matchBefore(/[\w$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const line = context.state.doc.lineAt(context.pos);
  const request = {
    language,
    text: context.state.doc.toString(),
    offset: context.pos,
    line: line.number,
    column: context.pos - line.from + 1,
    word: word.text,
  };
  const answers = await Promise.all(
    mine.map((p) => p.host.invoke(`provider:${p.id}`, [request], 1500).catch(() => null)),
  );
  const options: Completion[] = [];
  for (const answer of answers) {
    for (const item of Array.isArray(answer) ? answer : []) {
      const value: PluginCompletion =
        typeof item === 'string' ? { label: item } : (item as PluginCompletion);
      if (typeof value?.label !== 'string' || !value.label) continue;
      options.push({
        label: value.label,
        detail: typeof value.detail === 'string' ? value.detail : undefined,
        apply: typeof value.insertText === 'string' ? value.insertText : undefined,
        type: typeof value.kind === 'string' ? value.kind : 'text',
      });
    }
  }
  return options.length ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
};

const pluginHover = hoverTooltip(
  async (view, pos) => {
    const language = languageOf(view.state);
    const mine = providers.filter((p) => p.kind === 'hover' && matches(p.language, language));
    if (!mine.length) return null;
    const word = view.state.wordAt(pos);
    if (!word) return null;
    const request = {
      language,
      text: view.state.doc.toString(),
      offset: pos,
      word: view.state.sliceDoc(word.from, word.to),
    };
    for (const p of mine) {
      const answer = await p.host.invoke(`provider:${p.id}`, [request], 1500).catch(() => null);
      if (typeof answer === 'string' && answer.trim()) {
        return {
          pos: word.from,
          end: word.to,
          above: true,
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'cm-pluginHover';
            dom.textContent = answer;
            dom.title = p.host.name;
            return { dom };
          },
        };
      }
    }
    return null;
  },
  { hoverTime: 400 },
);

// ---- Snippets ----

/** Snippets declared by plugins, by language ("*" for every language). */
const snippets = new Map<string, Map<string, Completion[]>>();

interface VsSnippet {
  prefix?: unknown;
  body?: unknown;
  description?: unknown;
}

const VARIABLES: Record<string, () => string> = {
  TM_FILENAME: () => basename(getActiveDoc()?.path ?? ''),
  TM_FILENAME_BASE: () => basename(getActiveDoc()?.path ?? '').replace(/\.[^.]*$/, ''),
  CURRENT_YEAR: () => String(new Date().getFullYear()),
  CURRENT_MONTH: () => String(new Date().getMonth() + 1).padStart(2, '0'),
  CURRENT_DATE: () => String(new Date().getDate()).padStart(2, '0'),
};

/** VS Code's snippet syntax in CodeMirror's: $1 → ${1}, $0 last, choices → their first one. */
export function convertSnippet(body: string): string {
  let max = 0;
  for (const match of body.matchAll(/\$\{?(\d+)/g)) max = Math.max(max, Number(match[1]));
  return (
    body
      .replace(
        /\$\{(\d+)\|([^|}]*)[^}]*\|\}/g,
        (_m, n: string, first: string) => `\${${n}:${first.split(',')[0]}}`,
      )
      // Known variables are filled in; others are inserted as their name, as VS Code does.
      .replace(/\$\{?([A-Z_]+)\}?/g, (_whole, name: string) =>
        name in VARIABLES ? VARIABLES[name]!() : name,
      )
      .replace(/\$\{0(:[^}]*)?\}|\$0/g, (_m, def?: string) => `\${${max + 1}${def ?? ''}}`)
      .replace(/\$(\d+)/g, (_m, n: string) => `\${${n}}`)
  );
}

export function setSnippets(plugin: string, language: string, file: Record<string, VsSnippet>) {
  const list: Completion[] = [];
  for (const [name, snippet] of Object.entries(file)) {
    const prefixes = Array.isArray(snippet.prefix) ? snippet.prefix : [snippet.prefix];
    const body = Array.isArray(snippet.body)
      ? snippet.body.map(String).join('\n')
      : String(snippet.body ?? '');
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string' || !prefix) continue;
      list.push(
        snippetCompletion(convertSnippet(body), {
          label: prefix,
          detail: typeof snippet.description === 'string' ? snippet.description : name,
          type: 'snippet',
        }),
      );
    }
  }
  let byPlugin = snippets.get(language);
  if (!byPlugin) {
    byPlugin = new Map();
    snippets.set(language, byPlugin);
  }
  byPlugin.set(plugin, list);
}

export function removeSnippets(plugin: string) {
  for (const byPlugin of snippets.values()) byPlugin.delete(plugin);
}

const snippetCompletions: CompletionSource = (context) => {
  const language = languageOf(context.state);
  const options = [
    ...[...(snippets.get(language)?.values() ?? [])].flat(),
    ...[...(snippets.get('*')?.values() ?? [])].flat(),
  ];
  if (!options.length) return null;
  const word = context.matchBefore(/[\w$-]+/);
  if (!word && !context.explicit) return null;
  return { from: word?.from ?? context.pos, options, validFor: /^[\w$-]*$/ };
};

addEditorExtensions(
  EditorState.languageData.of(() => [
    { autocomplete: pluginCompletions },
    { autocomplete: snippetCompletions },
  ]),
  pluginHover,
);
