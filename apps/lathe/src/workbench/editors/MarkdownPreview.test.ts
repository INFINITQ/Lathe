import { describe, expect, it } from 'vitest';
import { isLocal } from '../../lsp/sanitize';
import { renderPreview } from './MarkdownPreview';

function blocks(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  return [...root.querySelectorAll<HTMLElement>(':scope > [data-line]')].map((el) => ({
    line: Number(el.dataset.line),
    el,
  }));
}

describe('Markdown preview', () => {
  it('marks each block with the line it starts on', () => {
    const source = [
      '---', // 0: front matter, not shown
      'title: x',
      '---',
      '# Title', // 3
      '',
      'Some *text*', // 5
      'more',
      '',
      '[ref]: https://example.com', // 8: a link definition (no block)
      '',
      '```py', // 10
      'print(1)',
      '```',
      '- [x] done', // 13
      '- [ ] todo',
    ].join('\r\n');
    const found = blocks(renderPreview(source));
    expect(found.map((b) => b.line)).toEqual([3, 5, 10, 13]);
    expect(found[0]!.el.querySelector('h1')?.textContent).toBe('Title');
    expect(found[3]!.el.textContent).toContain('☑ done');
    expect(found[3]!.el.textContent).toContain('☐ todo');
    expect(renderPreview(source)).not.toContain('title: x');
  });

  it('keeps links to files and headings, and nothing that runs', () => {
    const html = renderPreview(
      [
        '[docs](docs/guide.md#L3) [top](#title) [site](https://example.com)',
        '[bad](javascript:alert(1))',
        '',
        '![local](img/logo.png) ![remote](https://example.com/x.png)',
        '',
        '<script>alert(1)</script><img src=x onerror=alert(1)>',
      ].join('\n'),
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['docs/guide.md#L3', '#title', 'https://example.com', null]);
    const images = [...root.querySelectorAll('img')];
    expect(images.map((i) => i.dataset.localSrc)).toEqual(['img/logo.png', 'x']);
    expect(images.every((i) => !i.getAttribute('src') && !i.getAttribute('onerror'))).toBe(true);
    expect(root.querySelector('script')).toBeNull();
  });

  it('treats network paths and URLs as not local', () => {
    expect(isLocal('docs/a.md')).toBe(true);
    expect(isLocal('C:\\notes\\a.png')).toBe(true);
    expect(isLocal('\\\\server\\share\\a.png')).toBe(false);
    expect(isLocal('//server/share/a.png')).toBe(false);
    expect(isLocal('java\tscript:alert(1)')).toBe(false);
    expect(isLocal('file:///C:/a.png')).toBe(false);
  });
});
