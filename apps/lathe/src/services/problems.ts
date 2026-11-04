// Problems: errors and warnings by file, from builds now and language servers later. Each
// source ("build", "lsp:python"…) replaces its own list.

import { create } from 'zustand';
import { plainText } from '../lib/ansi';
import { isAbsolute, resolve } from '../lib/paths';

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}

export const useProblems = create<{ bySource: Record<string, Problem[]> }>(() => ({
  bySource: {},
}));

export function setProblems(source: string, problems: Problem[]) {
  useProblems.setState((s) => ({ bySource: { ...s.bySource, [source]: problems } }));
}

export function allProblems(state = useProblems.getState()): Problem[] {
  return Object.values(state.bySource).flat();
}

const severity = (word: string): Problem['severity'] =>
  /error/i.test(word) ? 'error' : /warn/i.test(word) ? 'warning' : 'info';

/**
 * Compiler and linter output as problems: gcc/clang, MSVC and C#, rustc and cargo, javac, tsc
 * (plain and pretty), go, and ESLint's stylish format. Terminal escapes are ignored.
 */
export function parseProblems(output: string, cwd: string, source = 'build'): Problem[] {
  const problems: Problem[] = [];
  const at = (file: string) => (isAbsolute(file) ? file : resolve(cwd, file));
  const add = (
    file: string,
    line: string,
    column: string | undefined,
    word: string,
    message: string,
  ) =>
    problems.push({
      path: at(file.trim()),
      line: Number(line),
      column: Number(column ?? 1),
      severity: severity(word),
      message: message.trim(),
      source,
    });
  let rustMessage: { word: string; message: string } | null = null;
  let eslintFile: string | null = null;
  for (const line of plainText(output).split('\n')) {
    let m = /^(\S.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/.exec(line);
    if (m) {
      if (m[4] !== 'note') add(m[1]!, m[2]!, m[3], m[4]!, m[5]!);
      continue;
    }
    m = /^(\S.*?):(\d+):(\d+)\s+-\s+(error|warning)\s+TS\d+:\s+(.*)$/.exec(line);
    if (m) {
      add(m[1]!, m[2]!, m[3], m[4]!, m[5]!);
      continue;
    }
    m = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s+(fatal error|error|warning)\s+[A-Z]+\d+\s*:\s+(.*)$/.exec(
      line,
    );
    if (m) {
      add(m[1]!, m[2]!, m[3], m[4]!, m[5]!);
      continue;
    }
    m = /^(error|warning)(?:\[\w+\])?:\s+(.*)$/.exec(line);
    if (m) {
      rustMessage = { word: m[1]!, message: m[2]! };
      continue;
    }
    m = /^\s*-->\s+(.+?):(\d+):(\d+)$/.exec(line);
    if (m && rustMessage) {
      add(m[1]!, m[2]!, m[3], rustMessage.word, rustMessage.message);
      rustMessage = null;
      continue;
    }
    m = /^(\S.*\.java):(\d+):\s+(error|warning):\s+(.*)$/.exec(line);
    if (m) {
      add(m[1]!, m[2]!, undefined, m[3]!, m[4]!);
      continue;
    }
    m = /^(\S.*?\.go):(\d+):(\d+):\s+(.*)$/.exec(line);
    if (m) {
      add(m[1]!, m[2]!, m[3], 'error', m[4]!);
      continue;
    }
    // ESLint's stylish format: the file on its own line, then "  3:5  error  message  rule".
    m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/.exec(line);
    if (m && eslintFile) {
      add(eslintFile, m[1]!, m[2], m[3]!, m[4]!);
      continue;
    }
    eslintFile = /^(?:[a-zA-Z]:)?[\\/]?\S.*\.[a-zA-Z]{1,5}$/.test(line) ? line.trim() : null;
  }
  return problems;
}
