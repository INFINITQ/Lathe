import { describe, expect, it } from 'vitest';
import { appendToList, listShape, parseJsonc, removeFromList, replaceInList } from './jsonc';

const FILE = `// Mine
[
  // Terminal
  { "key": "ctrl+shift+t", "command": "terminal.new" },
  /* settings */ { "key": "ctrl+,", "command": "-preferences.openSettings" },
  { "key": "f1", "command": "quickOpen.commands", "when": "a, b" }
]
`;

describe('JSONC lists', () => {
  it('finds each entry, past comments and commas inside strings', () => {
    const shape = listShape(FILE)!;
    expect(shape.items).toHaveLength(3);
    expect(FILE.slice(shape.items[2]!.start, shape.items[2]!.end)).toBe(
      '{ "key": "f1", "command": "quickOpen.commands", "when": "a, b" }',
    );
    expect(listShape('{}')).toBeNull();
    expect(listShape('[1] 2')).toBeNull();
  });

  it('appends, keeping comments', () => {
    const next = appendToList(FILE, { key: 'f2', command: 'x' });
    expect(next).toContain('// Terminal');
    expect(next).toContain('/* settings */');
    expect(parseJsonc<unknown[]>(next)).toHaveLength(4);
    expect(parseJsonc<{ key: string }[]>(next)[3]!.key).toBe('f2');
    expect(parseJsonc(appendToList('', { a: 1 }))).toEqual([{ a: 1 }]);
    expect(parseJsonc(appendToList('[]', { a: 1 }))).toEqual([{ a: 1 }]);
    expect(parseJsonc(appendToList('[\n  {"a": 1},\n]', { b: 2 }))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('replaces one entry', () => {
    const next = replaceInList(FILE, 1, { key: 'ctrl+.', command: 'y' });
    expect(next).toContain('/* settings */ {');
    expect(parseJsonc<{ key: string }[]>(next).map((b) => b.key)).toEqual([
      'ctrl+shift+t',
      'ctrl+.',
      'f1',
    ]);
  });

  it('removes the first, middle, last and only entries', () => {
    const keys = (text: string) => parseJsonc<{ key: string }[]>(text).map((b) => b.key);
    expect(keys(removeFromList(FILE, 0))).toEqual(['ctrl+,', 'f1']);
    expect(removeFromList(FILE, 0)).toContain('// Terminal');
    expect(keys(removeFromList(FILE, 1))).toEqual(['ctrl+shift+t', 'f1']);
    expect(keys(removeFromList(FILE, 2))).toEqual(['ctrl+shift+t', 'ctrl+,']);
    expect(parseJsonc(removeFromList('[{"a": 1}]', 0))).toEqual([]);
    expect(parseJsonc(removeFromList('[\n  {"a": 1},\n]', 0))).toEqual([]);
    expect(() => removeFromList(FILE, 5)).toThrow(RangeError);
  });
});
