import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { type DocSymbol, documentSymbols, symbolPath } from './symbols';

async function stateFor(language: string, text: string): Promise<EditorState> {
  const description = LanguageDescription.matchLanguageName(languages, language, false);
  if (!description) throw new Error(`no ${language}`);
  const support = await description.load();
  return EditorState.create({ doc: text, extensions: [support] });
}

/** "kind name" lines, indented by depth. */
function outline(symbols: DocSymbol[], depth = 0): string[] {
  return symbols.flatMap((s) => [
    `${'  '.repeat(depth)}${s.kind} ${s.name}`,
    ...outline(s.children, depth + 1),
  ]);
}

describe('documentSymbols', () => {
  it('reads Python classes, methods and functions', async () => {
    const state = await stateFor(
      'Python',
      'import os\n\nLIMIT = 10\n\nclass Shape:\n    def area(self):\n        def helper():\n            pass\n        return 0\n\n@cache\ndef fib(n):\n    return n\n',
    );
    expect(outline(documentSymbols(state, 1000))).toEqual([
      'variable LIMIT',
      'class Shape',
      '  method area',
      '    function helper',
      'function fib',
    ]);
  });

  it('reads TypeScript declarations, exports and top-level constants', async () => {
    const state = await stateFor(
      'TypeScript',
      'export interface Point { x: number }\ntype Id = string;\nenum Color { Red }\nexport const add = (a: number) => a;\nexport class Box {\n  size = 1;\n  open(): void {}\n}\nfunction main() {\n  const local = 1;\n}\n',
    );
    expect(outline(documentSymbols(state, 1000))).toEqual([
      'interface Point',
      'type Id',
      'enum Color',
      'function add',
      'class Box',
      '  property size',
      '  method open',
      'function main',
    ]);
  });

  it('reads Rust items and C++ functions after their return type', async () => {
    const rust = await stateFor(
      'Rust',
      'struct Point { x: i32 }\nimpl Point {\n    fn len(&self) -> i32 { 0 }\n}\nmod util { fn helper() {} }\nfn main() {}\n',
    );
    expect(outline(documentSymbols(rust, 1000))).toEqual([
      'struct Point',
      'namespace impl Point',
      '  function len',
      'module util',
      '  function helper',
      'function main',
    ]);
    const cpp = await stateFor(
      'C++',
      'namespace geo {\nstruct Point { int x; };\nstd::string name(Point p) { return ""; }\n}\nint main() { struct Point p; return 0; }\n',
    );
    expect(outline(documentSymbols(cpp, 1000))).toEqual([
      'namespace geo',
      '  struct Point',
      '  function name',
      'function main',
    ]);
  });

  it('nests Markdown headings by level', async () => {
    const state = await stateFor(
      'Markdown',
      '# Title\n\ntext\n\n## Part one\n\n### Detail\n\n## Part two\n',
    );
    const symbols = documentSymbols(state, 1000);
    expect(outline(symbols)).toEqual([
      'heading Title',
      '  heading Part one',
      '    heading Detail',
      '  heading Part two',
    ]);
  });

  it('finds the symbols around a position', async () => {
    const text = 'class Shape:\n    def area(self):\n        return 0\n';
    const state = await stateFor('Python', text);
    const path = symbolPath(documentSymbols(state, 1000), text.indexOf('return'));
    expect(path.map((s) => s.name)).toEqual(['Shape', 'area']);
  });
});
