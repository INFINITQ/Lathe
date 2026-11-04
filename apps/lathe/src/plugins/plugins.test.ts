import { describe, expect, it } from 'vitest';
import { convertSnippet } from './providers';
import { themeVariables } from './themes';

describe('snippets in VS Code format', () => {
  it("become CodeMirror's, with $0 last", () => {
    expect(convertSnippet('if __name__ == "__main__":\n    ${1:main()}$0')).toBe(
      'if __name__ == "__main__":\n    ${1:main()}${2}',
    );
    expect(convertSnippet('for ($1; $2) {\n\t$0\n}')).toBe('for (${1}; ${2}) {\n\t${3}\n}');
  });

  it('take the first choice and fill in known variables', () => {
    const year = String(new Date().getFullYear());
    expect(convertSnippet('${1|let,const,var|} x // $CURRENT_YEAR $UNKNOWN')).toBe(
      `\${1:let} x // ${year} UNKNOWN`,
    );
  });
});

describe('VS Code colour themes', () => {
  it("map onto Lathe's tokens, the most specific scope winning", () => {
    const vars = themeVariables({
      colors: {
        'editor.background': '#101010',
        'editor.foreground': '#eeeeee',
        'button.background': '#ff8800',
        'button.foreground': '#000000',
      },
      tokenColors: [
        { scope: 'keyword', settings: { foreground: '#aa00aa' } },
        { scope: 'keyword.control', settings: { foreground: '#ff00ff' } },
        { scope: 'comment, punctuation.definition.comment', settings: { foreground: '#777777' } },
        { scope: ['string'], settings: { foreground: '#00aa00' } },
      ],
    });
    expect(vars['--bg']).toBe('#101010');
    expect(vars['--text']).toBe('#eeeeee');
    expect(vars['--accent']).toBe('#ff8800');
    expect(vars['--accent-ink']).toBe('#000000');
    expect(vars['--syn-keyword']).toBe('#aa00aa');
    expect(vars['--syn-comment']).toBe('#777777');
    expect(vars['--syn-string']).toBe('#00aa00');
    expect(vars['--syn-function']).toBeUndefined();
  });
});
