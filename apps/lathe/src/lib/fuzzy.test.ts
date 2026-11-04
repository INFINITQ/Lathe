import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from './fuzzy';

describe('fuzzy matching', () => {
  it('matches characters in order, ignoring case', () => {
    expect(fuzzyMatch('tsb', 'Toggle sidebar')?.indices).toEqual([0, 7, 11]);
    expect(fuzzyMatch('xyz', 'Toggle sidebar')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it("doesn't jump to a word start that leaves the rest of the query unmatched", () => {
    expect(fuzzyMatch('report', 'report a problem')?.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fuzzyMatch('rap', 'report a problem')?.indices).toEqual([0, 7, 9]);
  });

  it('ranks word starts and runs above scattered letters', () => {
    const titles = ['File: Save as', 'View: Toggle sidebar', 'File: Save'];
    const sorted = fuzzyFilter(titles, 'save', (t) => t).map((r) => r.item);
    expect(sorted[0]).toBe('File: Save');
    const ranked = fuzzyFilter(['Format document', 'Find in files'], 'fd', (t) => t);
    expect(ranked[0]?.item).toBe('Format document');
  });
});
