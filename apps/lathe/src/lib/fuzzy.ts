// Fuzzy matching for short lists (commands, languages, recent folders). Files are matched in
// Rust (nucleo), which is much faster on big folders.

export interface FuzzyMatch {
  score: number;
  /** Matched character positions in the text, for highlighting. */
  indices: number[];
}

/**
 * Matches the query's characters in order, ignoring case. Consecutive matches and matches at
 * the start of words score higher. Null when it doesn't match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  /** Whether q[from…] still matches somewhere in t[start…]. */
  const restFits = (from: number, start: number) => {
    for (let k = from, at = start; k < q.length; k++, at++) {
      at = t.indexOf(q[k]!, at);
      if (at < 0) return false;
    }
    return true;
  };
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    // Prefer a nearby occurrence at a word start, as long as the rest of the query still fits
    // after it ("report" must not jump to the p of "problem" in "report a problem").
    let at = t.indexOf(ch, from);
    if (at < 0) return null;
    for (let i = at; i < t.length; i++) {
      if (t[i] !== ch) continue;
      const before = text[i - 1];
      const wordStart =
        i === 0 ||
        /[\s\-_./:\\]/.test(before ?? '') ||
        (text[i] !== t[i] && before === before?.toLowerCase());
      if (wordStart) {
        if ((i === at || i - at < 12) && restFits(qi + 1, i + 1)) at = i;
        break;
      }
    }
    const before = text[at - 1];
    const startOfWord =
      at === 0 ||
      /[\s\-_./:\\]/.test(before ?? '') ||
      (text[at] !== t[at] && before === before?.toLowerCase());
    score += 1;
    if (at === previous + 1) score += 4;
    if (startOfWord) score += 6;
    if (at === 0) score += 3;
    indices.push(at);
    previous = at;
    from = at + 1;
  }
  // Shorter texts win ties.
  score -= text.length * 0.01;
  return { score, indices };
}

/** Sorts `items` by how well `text(item)` matches `query`, dropping the ones that don't. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match });
  }
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score);
  return out;
}
