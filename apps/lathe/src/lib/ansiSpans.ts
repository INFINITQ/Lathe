// ANSI escape codes (coloured tracebacks, coloured program output) as styled pieces of text, for
// notebook outputs. Colours 0–15 use the theme's palette (--ansi-0 … --ansi-15 in tokens.css,
// the terminal's colours); 256-colour and true-colour codes become rgb(). Other escape codes
// (cursor movement, titles) are dropped.

export interface AnsiSpan {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

type Style = Omit<AnsiSpan, 'text'>;

const CUBE = [0, 95, 135, 175, 215, 255];

function color256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  return `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})`;
}

function same(a: Style, b: Style): boolean {
  return (
    a.color === b.color &&
    a.background === b.background &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline
  );
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Colour codes (group 1 holds their numbers), other CSI codes, OSC titles, character sets. */
const ESCAPES = new RegExp(
  [
    `${ESC}\\[([\\d;]*)m`,
    `${ESC}\\[[\\d;?]*[A-Za-z]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[()][AB012]`,
  ].join('|'),
  'g',
);

function apply(style: Style, codes: number[]): Style {
  const next: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (code === 0) {
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.color = `var(--ansi-${code - 30})`;
    else if (code >= 90 && code <= 97) next.color = `var(--ansi-${code - 82})`;
    else if (code === 39) delete next.color;
    else if (code >= 40 && code <= 47) next.background = `var(--ansi-${code - 40})`;
    else if (code >= 100 && code <= 107) next.background = `var(--ansi-${code - 92})`;
    else if (code === 49) delete next.background;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? 'color' : 'background';
      if (codes[i + 1] === 5) {
        next[key] = color256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        next[key] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        i += 4;
      }
    }
  }
  return next;
}

/** Splits text with ANSI codes into styled spans. */
export function ansiSpans(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  const push = (text: string) => {
    if (!text) return;
    const last = spans.at(-1);
    if (last && same(last, style)) last.text += text;
    else spans.push({ ...style, text });
  };
  let at = 0;
  for (const match of input.matchAll(ESCAPES)) {
    push(input.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[1] === undefined) continue;
    const codes = match[1] === '' ? [0] : match[1].split(';').map((c) => Number(c) || 0);
    style = apply(style, codes);
  }
  push(input.slice(at));
  return spans;
}

/** What a terminal would show for a carriage return: the line rewritten from its start
 * (progress bars). */
export function applyCarriageReturns(text: string): string {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cut = body.lastIndexOf('\r');
      return cut >= 0 ? body.slice(cut + 1) : body;
    })
    .join('\n');
}
