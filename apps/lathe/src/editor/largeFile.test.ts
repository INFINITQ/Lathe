import { afterEach, describe, expect, it } from 'vitest';
import { useSettings } from '../services/settings';
import { createUntitled, releaseDocument } from './documents';
import { isLargeDoc } from './setup';

describe('large-file mode', () => {
  const made: ReturnType<typeof createUntitled>[] = [];
  const doc = (text: string) => {
    const d = createUntitled(text);
    made.push(d);
    return d;
  };

  afterEach(() => {
    for (const d of made.splice(0)) releaseDocument(d);
    useSettings.setState((s) => ({
      user: { ...s.user, 'editor.largeFileOptimizations': undefined },
    }));
  });

  it('starts past 50,000 lines or 2 MB', () => {
    expect(isLargeDoc(doc('a small file\n'))).toBe(false);
    expect(isLargeDoc(doc('x\n'.repeat(50_001)))).toBe(true);
    expect(isLargeDoc(doc('y'.repeat(2_000_001)))).toBe(true);
  });

  it('is off when the setting says so', () => {
    useSettings.setState((s) => ({ user: { ...s.user, 'editor.largeFileOptimizations': false } }));
    expect(isLargeDoc(doc('x\n'.repeat(60_000)))).toBe(false);
  });
});
