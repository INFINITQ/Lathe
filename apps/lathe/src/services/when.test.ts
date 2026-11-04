import { describe, expect, it } from 'vitest';
import { evaluate } from './when';

describe('when clauses', () => {
  const ctx = { editorFocus: true, sidebarVisible: false, editorLangId: 'python', tabSize: 4 };

  it('handles names, not, and, or and parentheses', () => {
    expect(evaluate('editorFocus', ctx)).toBe(true);
    expect(evaluate('!sidebarVisible', ctx)).toBe(true);
    expect(evaluate('editorFocus && sidebarVisible', ctx)).toBe(false);
    expect(evaluate('sidebarVisible || editorFocus', ctx)).toBe(true);
    expect(evaluate('!(editorFocus && !sidebarVisible)', ctx)).toBe(false);
    expect(evaluate('unknownKey', ctx)).toBe(false);
  });

  it('compares with strings and numbers', () => {
    expect(evaluate("editorLangId == 'python'", ctx)).toBe(true);
    expect(evaluate('editorLangId != "python"', ctx)).toBe(false);
    expect(evaluate('tabSize == 4', ctx)).toBe(true);
  });

  it('treats empty clauses as true and broken ones as false', () => {
    expect(evaluate(undefined, ctx)).toBe(true);
    expect(evaluate('  ', ctx)).toBe(true);
    expect(evaluate('editorFocus &&', ctx)).toBe(false);
  });
});
