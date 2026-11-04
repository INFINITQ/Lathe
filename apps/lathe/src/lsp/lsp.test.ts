import { describe, expect, it } from 'vitest';
import { sanitizeHTML } from './sanitize';
import { pathToUri, uriToPath } from './uri';

describe('file URIs', () => {
  it('writes them as VS Code does and reads every common spelling back', () => {
    expect(pathToUri('C:\\Users\\me\\my file#1.ts')).toBe('file:///c%3A/Users/me/my%20file%231.ts');
    expect(uriToPath('file:///c%3A/Users/me/my%20file%231.ts')).toBe('C:\\Users\\me\\my file#1.ts');
    expect(uriToPath('file:///C:/Users/me/x.py')).toBe('C:\\Users\\me\\x.py');
    expect(uriToPath('file://server/share/x.c')).toBe('\\\\server\\share\\x.c');
    expect(pathToUri('\\\\server\\share\\x.c')).toBe('file://server/share/x.c');
    expect(uriToPath('untitled:Untitled-1')).toBeNull();
  });
});

describe('sanitizeHTML', () => {
  it('keeps formatting and drops anything active', () => {
    const html = sanitizeHTML(
      '<p onclick="x()">Hi <strong>there</strong><script>alert(1)</script><img src=x onerror=y>' +
        '<a href="javascript:evil()">bad</a> <a href="https://docs.python.org">ok</a>' +
        '<custom-tag>inner <em>text</em></custom-tag><style>*{}</style></p><pre><code class="language-py">x = 1</code></pre>',
    );
    expect(html).toBe(
      '<p>Hi <strong>there</strong><a>bad</a> <a href="https://docs.python.org">ok</a>inner <em>text</em></p><pre><code class="language-py">x = 1</code></pre>',
    );
  });
});

describe('configurationFor', () => {
  it('answers workspace/configuration from dotted settings', async () => {
    const { configurationFor } = await import('./server');
    const settings = {
      'python.analysis': { typeCheckingMode: 'standard' },
      'python.pythonPath': 'py',
    };
    expect(configurationFor(settings, 'python')).toEqual({
      analysis: { typeCheckingMode: 'standard' },
      pythonPath: 'py',
    });
    expect(configurationFor(settings, 'python.analysis.typeCheckingMode')).toBe('standard');
    expect(configurationFor(settings, 'rust-analyzer')).toBeNull();
    expect(configurationFor(undefined, 'x')).toBeNull();
  });
});
