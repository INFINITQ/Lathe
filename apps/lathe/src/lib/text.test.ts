import { describe, expect, it } from 'vitest';
import { plainText } from './ansi';
import { parseJsonc, stripJsonc } from './jsonc';

const ESC = String.fromCharCode(27);

describe('plainText', () => {
  it('drops colours, cursor moves and titles', () => {
    const raw = `${ESC}]0;title${String.fromCharCode(7)}${ESC}[1;31merror${ESC}[0m: bad${ESC}[?25h\r\nnext`;
    expect(plainText(raw)).toBe('error: bad\nnext');
  });

  it('keeps only what a carriage return left on the line', () => {
    expect(plainText('10%\r50%\r100%\r\ndone')).toBe('100%\ndone');
  });
});

describe('jsonc', () => {
  it('strips comments and trailing commas but not string contents', () => {
    const text = `${String.fromCharCode(0xfeff)}{
      // a comment
      "url": "http://example.com/*not a comment*/", /* block */
      "list": [1, 2,],
      "quote": "a \\"b\\" // c",
    }`;
    expect(parseJsonc(text)).toEqual({
      url: 'http://example.com/*not a comment*/',
      list: [1, 2],
      quote: 'a "b" // c',
    });
  });

  it('keeps commas inside strings', () => {
    expect(stripJsonc('{"a": ",]"}')).toBe('{"a": ",]"}');
  });

  it('throws on broken JSON', () => {
    expect(() => parseJsonc('{"a": }')).toThrow(SyntaxError);
  });
});
