// Which language a file is, and loading its CodeMirror support lazily (each language is its
// own chunk, so start-up only pays for what you open).

import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { basename } from '../lib/paths';

/** VS Code's language ids for CodeMirror's language names, so settings like "[python]" work. */
const IDS: Record<string, string> = {
  C: 'c',
  'C++': 'cpp',
  'C#': 'csharp',
  JavaScript: 'javascript',
  JSX: 'javascriptreact',
  TypeScript: 'typescript',
  TSX: 'typescriptreact',
  JSON: 'json',
  Python: 'python',
  Rust: 'rust',
  Go: 'go',
  Java: 'java',
  Kotlin: 'kotlin',
  PHP: 'php',
  Ruby: 'ruby',
  Shell: 'shellscript',
  PowerShell: 'powershell',
  SQL: 'sql',
  YAML: 'yaml',
  TOML: 'toml',
  Markdown: 'markdown',
  HTML: 'html',
  CSS: 'css',
  Sass: 'sass',
  SCSS: 'scss',
  Less: 'less',
  XML: 'xml',
  Lua: 'lua',
  Swift: 'swift',
  Dart: 'dart',
  Dockerfile: 'dockerfile',
  Diff: 'diff',
};

export const LANGUAGES: readonly LanguageDescription[] = languages;

export function languageIdOf(language: LanguageDescription | null): string {
  if (!language) return 'plaintext';
  return IDS[language.name] ?? language.name.toLowerCase().replace(/[^a-z0-9#+]+/g, '');
}

export function languageNameOf(language: LanguageDescription | null): string {
  return language?.name ?? 'Plain text';
}

export function languageByName(name: string): LanguageDescription | null {
  return LanguageDescription.matchLanguageName(languages, name, false);
}

/** The language for a file, from its name, or from a `#!` line for scripts without one. */
export function detectLanguage(path: string | null, text = ''): LanguageDescription | null {
  if (path) {
    const match = LanguageDescription.matchFilename(languages, basename(path));
    if (match) return match;
  }
  const first = text.slice(0, 200).split('\n', 1)[0] ?? '';
  if (first.startsWith('#!')) {
    if (/python/.test(first)) return languageByName('Python');
    if (/\b(node|deno|bun)\b/.test(first)) return languageByName('JavaScript');
    if (/\b(ba|z|da)?sh\b/.test(first)) return languageByName('Shell');
    if (/\bpwsh\b|powershell/.test(first)) return languageByName('PowerShell');
  }
  return null;
}

/** How a file is indented: tabs or spaces, and how wide. */
export function detectIndent(text: string): { tabs: boolean; size: number } | null {
  let tabs = 0;
  let spaces = 0;
  const widths = new Map<number, number>();
  let previous = 0;
  let lines = 0;
  for (const line of text.split('\n', 2000)) {
    lines++;
    if (!line.trim()) continue;
    const lead = /^[\t ]*/.exec(line)![0];
    if (lead.startsWith('\t')) {
      tabs++;
      continue;
    }
    if (!lead.length) {
      previous = 0;
      continue;
    }
    spaces++;
    const delta = Math.abs(lead.length - previous);
    if (delta > 0 && delta <= 8) widths.set(delta, (widths.get(delta) ?? 0) + 1);
    previous = lead.length;
  }
  if (lines < 2 || tabs + spaces === 0) return null;
  if (tabs > spaces) return { tabs: true, size: 4 };
  let best = 4;
  let bestCount = 0;
  for (const [width, count] of widths) {
    if (count > bestCount || (count === bestCount && width < best)) {
      best = width;
      bestCount = count;
    }
  }
  return { tabs: false, size: best };
}
