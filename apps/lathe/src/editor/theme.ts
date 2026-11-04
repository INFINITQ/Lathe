// Lathe's editor look, drawn entirely from the CSS design tokens (styles/tokens.css), so light,
// dark and the accent colour switch without rebuilding any editor.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const chrome = EditorView.theme({
  '&': {
    color: 'var(--code-fg)',
    backgroundColor: 'var(--bg)',
    height: '100%',
    fontSize: 'var(--code-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-code)',
    lineHeight: 'var(--code-line-height)',
    fontVariantLigatures: 'var(--code-ligatures)',
  },
  '.cm-content': { caretColor: 'var(--accent-fg)', padding: '6px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-fg)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-4)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 18px', minWidth: '36px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-4)', padding: '0 4px' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--hover)',
    border: '1px solid var(--line-strong)',
    color: 'var(--text-2)',
    borderRadius: '3px',
    padding: '0 4px',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    outline: '1px solid var(--line-strong)',
    color: 'inherit',
  },
  '.cm-nonmatchingBracket': { color: 'var(--danger)' },
  '.cm-searchMatch': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--line-strong)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  // Diagnostics (language servers, linters): wavy underlines in the theme's colours.
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--danger)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warning)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-lintRange-info, .cm-lintRange-hint': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--info)',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    textDecorationSkipInk: 'none',
  },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': {
    padding: '5px 10px 5px 9px',
    marginLeft: '0',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    lineHeight: '1.45',
    borderLeft: '3px solid var(--info)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-diagnosticSource': { color: 'var(--text-3)', fontSize: '11px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-overlay)',
    color: 'var(--text)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', lineHeight: '1.6' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--active)',
    color: 'var(--text)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-fg)' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-raised)',
    color: 'var(--text)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
});

/** "Mono": bright keywords, lime functions, grey strings, amber numbers, quiet punctuation. */
/** Lathe's syntax colours (also used to draw sticky scroll lines). */
export const mono = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
    ],
    color: 'var(--syn-keyword)',
    fontWeight: '500',
  },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.definition(t.variableName)),
      t.function(t.propertyName),
      t.macroName,
    ],
    color: 'var(--syn-function)',
  },
  {
    tag: [t.variableName, t.definition(t.variableName), t.propertyName, t.self, t.labelName],
    color: 'var(--syn-variable)',
  },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--syn-type)' },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.character, t.escape],
    color: 'var(--syn-string)',
  },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--syn-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator],
    color: 'var(--syn-punct)',
  },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: 'var(--syn-meta)' },
  { tag: t.tagName, color: 'var(--syn-function)' },
  { tag: t.attributeName, color: 'var(--syn-variable)' },
  { tag: t.attributeValue, color: 'var(--syn-string)' },
  { tag: t.heading, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: t.link, color: 'var(--syn-function)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--syn-string)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

/** The editor chrome plus the Mono syntax colours. */
export const latheTheme = [chrome, syntaxHighlighting(mono)];
