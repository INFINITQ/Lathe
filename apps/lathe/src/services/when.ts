// "When" clauses decide where a keybinding or menu item applies, as in VS Code:
//   editorFocus && !findWidgetVisible
//   resourceExtname == '.py' || editorLangId == 'python'
// Supported: identifiers, !, &&, ||, ==, !=, parentheses, 'strings', numbers, true/false.

export type Context = Record<string, unknown>;

type Token =
  { type: 'id'; value: string } | { type: 'str'; value: string } | { type: 'op'; value: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Error(`Unclosed string in "${text}"`);
      tokens.push({ type: 'str', value: text.slice(i + 1, end) });
      i = end + 1;
    } else if (/[&|=!]/.test(c) && /^(&&|\|\||==|!=)/.test(text.slice(i))) {
      tokens.push({ type: 'op', value: text.slice(i, i + 2) });
      i += 2;
    } else if ('!()'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
    } else {
      const match = /^[\w.\-:]+/.exec(text.slice(i));
      if (!match) throw new Error(`Unexpected "${c}" in "${text}"`);
      tokens.push({ type: 'id', value: match[0] });
      i += match[0].length;
    }
  }
  return tokens;
}

type Expr = (ctx: Context) => unknown;

function parse(text: string): Expr {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const primary = (): Expr => {
    const token = take();
    if (!token) throw new Error(`Unexpected end of "${text}"`);
    if (token.type === 'op' && token.value === '!') {
      const inner = primary();
      return (ctx) => !inner(ctx);
    }
    if (token.type === 'op' && token.value === '(') {
      const inner = or();
      const close = take();
      if (!close || close.value !== ')') throw new Error(`Missing ")" in "${text}"`);
      return inner;
    }
    if (token.type === 'str') return () => token.value;
    if (token.type === 'id') {
      if (token.value === 'true') return () => true;
      if (token.value === 'false') return () => false;
      if (/^-?\d+(\.\d+)?$/.test(token.value)) return () => Number(token.value);
      return (ctx) => ctx[token.value];
    }
    throw new Error(`Unexpected "${token.value}" in "${text}"`);
  };

  const comparison = (): Expr => {
    const left = primary();
    const op = peek();
    if (op?.type === 'op' && (op.value === '==' || op.value === '!=')) {
      take();
      const right = primary();
      // Values compare as strings, so `tabSize == 4` and `tabSize == '4'` both work.
      return op.value === '=='
        ? (ctx) => String(left(ctx)) === String(right(ctx))
        : (ctx) => String(left(ctx)) !== String(right(ctx));
    }
    return left;
  };

  const and = (): Expr => {
    let left = comparison();
    while (peek()?.value === '&&') {
      take();
      const a = left;
      const b = comparison();
      left = (ctx) => Boolean(a(ctx)) && Boolean(b(ctx));
    }
    return left;
  };

  const or = (): Expr => {
    let left = and();
    while (peek()?.value === '||') {
      take();
      const a = left;
      const b = and();
      left = (ctx) => Boolean(a(ctx)) || Boolean(b(ctx));
    }
    return left;
  };

  const expr = or();
  if (at < tokens.length) throw new Error(`Unexpected "${tokens[at]!.value}" in "${text}"`);
  return expr;
}

const cache = new Map<string, Expr>();

/** True when `when` holds in `ctx`. An empty clause always holds; a broken one never does. */
export function evaluate(when: string | undefined, ctx: Context): boolean {
  if (!when || !when.trim()) return true;
  let expr = cache.get(when);
  if (!expr) {
    try {
      expr = parse(when);
    } catch (err) {
      console.warn(String(err));
      expr = () => false;
    }
    cache.set(when, expr);
  }
  return Boolean(expr(ctx));
}
