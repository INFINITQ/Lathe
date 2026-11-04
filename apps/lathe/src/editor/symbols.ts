// A document's symbols (classes, functions, methods, headings…) read from its syntax tree, for
// the outline, the breadcrumbs, sticky scroll and "@" in quick open. Language servers will add
// richer symbols (M4); this works for every language with a Lezer grammar, with no server.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';

export type SymbolKind =
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'variable'
  | 'constant'
  | 'type'
  | 'module'
  | 'namespace'
  | 'key'
  | 'selector'
  | 'heading';

export interface DocSymbol {
  name: string;
  kind: SymbolKind;
  /** The whole definition. */
  from: number;
  to: number;
  /** Its name, for selecting it. */
  nameFrom: number;
  nameTo: number;
  children: DocSymbol[];
}

/** Syntax nodes that define something, by grammar (JS/TS, Python, Rust, C/C++, Java, Go). */
const KINDS: Record<string, SymbolKind> = {
  FunctionDeclaration: 'function',
  ClassDeclaration: 'class',
  MethodDeclaration: 'method',
  PropertyDeclaration: 'property',
  InterfaceDeclaration: 'interface',
  TypeAliasDeclaration: 'type',
  EnumDeclaration: 'enum',
  NamespaceDeclaration: 'namespace',
  ModuleDeclaration: 'module',
  AmbientDeclaration: 'module',
  FunctionDefinition: 'function',
  ClassDefinition: 'class',
  FunctionItem: 'function',
  StructItem: 'struct',
  UnionItem: 'struct',
  EnumItem: 'enum',
  TraitItem: 'interface',
  ImplItem: 'namespace',
  ModItem: 'module',
  TypeItem: 'type',
  ConstItem: 'constant',
  StaticItem: 'constant',
  MacroDefinition: 'function',
  ClassSpecifier: 'class',
  StructSpecifier: 'struct',
  UnionSpecifier: 'struct',
  EnumSpecifier: 'enum',
  NamespaceDefinition: 'namespace',
  ConstructorDeclaration: 'constructor',
  RecordDeclaration: 'class',
  AnnotationTypeDeclaration: 'interface',
  FunctionDecl: 'function',
  MethodDecl: 'method',
  TypeSpec: 'type',
};

/** Nodes that name a definition. */
const NAMES = new Set([
  'VariableDefinition',
  'PropertyDefinition',
  'PrivatePropertyDefinition',
  'TypeDefinition',
  'Definition',
  'DefName',
  'BoundIdentifier',
  'VariableName',
  'TypeIdentifier',
  'Identifier',
  'FieldIdentifier',
  'FieldName',
  'NamespaceIdentifier',
  'QualifiedIdentifier',
  'ScopedIdentifier',
  'DestructorName',
  'OperatorName',
  'PropertyName',
  'Name',
]);

/** Where a definition's body starts: names are never looked for inside these. */
const BODY =
  /Body|Block|List$|^ParamList|Parameters|ArgList|Arguments|Statement$|Initializer|ObjectType|Expression$|Type$/;

/** Kinds that can hold other definitions (and so are scopes for sticky scroll). */
export const SCOPES = new Set<SymbolKind>([
  'class',
  'struct',
  'interface',
  'enum',
  'function',
  'method',
  'constructor',
  'module',
  'namespace',
]);

const MAX_SYMBOLS = 5000;

function findName(node: SyntaxNode, depth = 0): SyntaxNode | null {
  // C and C++ put the name inside a declarator, after the return type.
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (/Declarator$/.test(child.name)) {
      const inner = findName(child, depth + 1);
      if (inner) return inner;
    }
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (NAMES.has(child.name)) return child;
  }
  if (depth >= 2) return null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (BODY.test(child.name) || /Declarator$/.test(child.name)) continue;
    const inner = findName(child, depth + 1);
    if (inner) return inner;
  }
  return null;
}

function hasChild(node: SyntaxNode, test: (name: string) => boolean): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (test(child.name)) return true;
  }
  return false;
}

function bodyStart(node: SyntaxNode): number {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (/Body$|List$|Block$/.test(child.name)) return child.from;
  }
  return node.to;
}

const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120);

/** A JS/TS `const x = …` or Python `x = …` at the top of a module. */
function variableSymbol(node: SyntaxNode, state: EditorState): DocSymbol | null {
  const name = node.getChild('VariableDefinition') ?? node.getChild('VariableName');
  if (!name) return null;
  const value = name.nextSibling?.nextSibling;
  const kind: SymbolKind =
    value && /ArrowFunction|FunctionExpression/.test(value.name)
      ? 'function'
      : value?.name === 'ClassExpression'
        ? 'class'
        : state.sliceDoc(node.from, node.from + 5) === 'const'
          ? 'constant'
          : 'variable';
  return {
    name: state.sliceDoc(name.from, name.to),
    kind,
    from: node.from,
    to: node.to,
    nameFrom: name.from,
    nameTo: name.to,
    children: [],
  };
}

/** Markdown headings, nested by level. */
function headings(state: EditorState, top: SyntaxNode): DocSymbol[] {
  const roots: DocSymbol[] = [];
  const stack: { level: number; symbol: DocSymbol }[] = [];
  for (let node = top.firstChild; node; node = node.nextSibling) {
    const m = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!m) continue;
    const level = Number(m[1]);
    const name = clip(state.sliceDoc(node.from, node.to).replace(/^#+|#+$|\n[=-]+$/g, ''));
    const symbol: DocSymbol = {
      name: name || '(empty heading)',
      kind: 'heading',
      from: node.from,
      to: state.doc.length,
      nameFrom: node.from,
      nameTo: node.to,
      children: [],
    };
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()!.symbol.to = node.from;
    (stack.at(-1)?.symbol.children ?? roots).push(symbol);
    stack.push({ level, symbol });
  }
  return roots;
}

/**
 * The symbols in `state`'s document, as a tree. Parses up to `budget` ms more of a big file
 * first; past that, it works with what has been parsed.
 */
export function documentSymbols(state: EditorState, budget = 50): DocSymbol[] {
  const tree = ensureSyntaxTree(state, state.doc.length, budget) ?? syntaxTree(state);
  const top = tree.topNode;
  if (top.name === 'Document' && hasChild(top, (n) => /Heading\d$/.test(n))) {
    return headings(state, top);
  }
  let count = 0;

  const walk = (node: SyntaxNode, parent: DocSymbol | null, out: DocSymbol[]) => {
    for (let child = node.firstChild; child && count < MAX_SYMBOLS; child = child.nextSibling) {
      const symbol = symbolOf(child, parent);
      if (symbol) {
        count++;
        out.push(symbol);
        walk(child, symbol, symbol.children);
      } else if (child.firstChild && !(parent && !SCOPES.has(parent.kind))) {
        walk(child, parent, out);
      }
    }
  };

  const symbolOf = (node: SyntaxNode, parent: DocSymbol | null): DocSymbol | null => {
    const name = node.name;
    const atTop = !parent || parent.kind === 'module' || parent.kind === 'namespace';
    if (
      name === 'VariableDeclaration' &&
      atTop &&
      /^(Script|ExportDeclaration)$/.test(node.parent?.name ?? '')
    ) {
      return variableSymbol(node, state);
    }
    if (name === 'AssignStatement' && !parent && node.parent?.name === 'Script') {
      return variableSymbol(node, state);
    }
    if (name === 'Property' && hasChild(node, (n) => n === 'PropertyName')) {
      // JSON keys (and JS object keys inside other keys).
      const key = node.getChild('PropertyName')!;
      if (node.parent?.parent?.name !== 'JsonText' && parent?.kind !== 'key') return null;
      return {
        name: state.sliceDoc(key.from, key.to).replace(/^"|"$/g, ''),
        kind: 'key',
        from: node.from,
        to: node.to,
        nameFrom: key.from,
        nameTo: key.to,
        children: [],
      };
    }
    if (name === 'RuleSet') {
      return {
        name: clip(state.sliceDoc(node.from, bodyStart(node))),
        kind: 'selector',
        from: node.from,
        to: node.to,
        nameFrom: node.from,
        nameTo: bodyStart(node),
        children: [],
      };
    }
    let kind = KINDS[name];
    if (!kind) return null;
    // C and C++ `struct Foo x;` and `enum E e;` only mention a type; definitions have a body.
    if (/Specifier$/.test(name) && !hasChild(node, (n) => /List$/.test(n))) return null;
    if (name === 'TypeSpec') {
      if (hasChild(node, (n) => n === 'StructType')) kind = 'struct';
      else if (hasChild(node, (n) => n === 'InterfaceType')) kind = 'interface';
    }
    if (kind === 'function' && parent && ['class', 'struct', 'interface'].includes(parent.kind)) {
      kind = 'method';
    }
    if (name === 'ImplItem') {
      const head = clip(state.sliceDoc(node.from, bodyStart(node)));
      return {
        name: head,
        kind,
        from: node.from,
        to: node.to,
        nameFrom: node.from,
        nameTo: bodyStart(node),
        children: [],
      };
    }
    const id = findName(node);
    if (!id) return null;
    return {
      name: clip(state.sliceDoc(id.from, id.to)),
      kind,
      from: node.from,
      to: node.to,
      nameFrom: id.from,
      nameTo: id.to,
      children: [],
    };
  };

  const out: DocSymbol[] = [];
  walk(top, null, out);
  return out;
}

/** The symbols around `pos`, outermost first (the breadcrumbs' symbol path). */
export function symbolPath(symbols: DocSymbol[], pos: number): DocSymbol[] {
  const path: DocSymbol[] = [];
  let level = symbols;
  for (;;) {
    const inside = level.find((s) => s.from <= pos && pos <= s.to);
    if (!inside) return path;
    path.push(inside);
    level = inside.children;
  }
}

/** Every symbol, depth first, with its container's name (quick open's "@" list). */
export function flatSymbols(
  symbols: DocSymbol[],
  container = '',
): { symbol: DocSymbol; container: string }[] {
  return symbols.flatMap((symbol) => [
    { symbol, container },
    ...flatSymbols(symbol.children, container ? `${container} › ${symbol.name}` : symbol.name),
  ]);
}
