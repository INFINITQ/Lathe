// Find and replace as a compact widget floating at the editor's top right (like VS Code's),
// instead of CodeMirror's full-width panel. The query lives in @codemirror/search's state, so
// match highlighting and the search commands keep working; this is only the UI around them.

import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  setSearchQuery,
} from '@codemirror/search';
import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type SelectionRange,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  runScopeHandlers,
  type Command,
  type DecorationSet,
  type KeyBinding,
  type Panel,
  type ViewUpdate,
} from '@codemirror/view';

/** Matches counted before the count reads "10000+". */
const MATCH_LIMIT = 10_000;
/** Bigger documents are recounted after a pause instead of on every change. */
const SYNC_COUNT_LIMIT = 500_000;
const COUNT_DELAY = 150;
/** Longest selection that seeds the query. */
const SEED_LIMIT = 1000;

// ── Icons (paths from Lucide, ISC licence), built with DOM APIs ──────────────────────────────

type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[];

const icons = {
  chevron: [['path', { d: 'm9 18 6-6-6-6' }]],
  matchCase: [
    ['path', { d: 'm2 16 4.039-9.69a.5.5 0 0 1 .923 0L11 16' }],
    ['path', { d: 'M22 9v7' }],
    ['path', { d: 'M3.304 13h6.392' }],
    ['circle', { cx: '18.5', cy: '12.5', r: '3.5' }],
  ],
  wholeWord: [
    ['circle', { cx: '7', cy: '12', r: '3' }],
    ['path', { d: 'M10 9v6' }],
    ['circle', { cx: '17', cy: '12', r: '3' }],
    ['path', { d: 'M14 7v8' }],
    ['path', { d: 'M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1' }],
  ],
  regexp: [
    ['path', { d: 'M17 3v10' }],
    ['path', { d: 'm12.67 5.5 8.66 5' }],
    ['path', { d: 'm12.67 10.5 8.66-5' }],
    ['path', { d: 'M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z' }],
  ],
  previous: [
    ['path', { d: 'm5 12 7-7 7 7' }],
    ['path', { d: 'M12 19V5' }],
  ],
  next: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'm19 12-7 7-7-7' }],
  ],
  inSelection: [
    ['path', { d: 'M5 3a2 2 0 0 0-2 2' }],
    ['path', { d: 'M19 3a2 2 0 0 1 2 2' }],
    ['path', { d: 'M21 19a2 2 0 0 1-2 2' }],
    ['path', { d: 'M5 21a2 2 0 0 1-2-2' }],
    ['path', { d: 'M9 3h1' }],
    ['path', { d: 'M14 3h1' }],
    ['path', { d: 'M9 21h1' }],
    ['path', { d: 'M14 21h1' }],
    ['path', { d: 'M3 9v1' }],
    ['path', { d: 'M3 14v1' }],
    ['path', { d: 'M21 9v1' }],
    ['path', { d: 'M21 14v1' }],
    ['path', { d: 'M7 8h8' }],
    ['path', { d: 'M7 12h10' }],
    ['path', { d: 'M7 16h6' }],
  ],
  close: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  replace: [
    ['path', { d: 'M14 4a1 1 0 0 1 1-1' }],
    ['path', { d: 'M15 10a1 1 0 0 1-1-1' }],
    ['path', { d: 'M21 4a1 1 0 0 0-1-1' }],
    ['path', { d: 'M21 9a1 1 0 0 1-1 1' }],
    ['path', { d: 'm3 7 3 3 3-3' }],
    ['path', { d: 'M6 10V5a2 2 0 0 1 2-2h2' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
  ],
  replaceAll: [
    ['path', { d: 'M14 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1' }],
    ['path', { d: 'M14 4a1 1 0 0 1 1-1' }],
    ['path', { d: 'M15 10a1 1 0 0 1-1-1' }],
    ['path', { d: 'M19 14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1' }],
    ['path', { d: 'M21 4a1 1 0 0 0-1-1' }],
    ['path', { d: 'M21 9a1 1 0 0 1-1 1' }],
    ['path', { d: 'm3 7 3 3 3-3' }],
    ['path', { d: 'M6 10V5a2 2 0 0 1 2-2h2' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1' }],
  ],
} satisfies Record<string, IconNode>;

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(nodes: IconNode): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs: Record<string, string> = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  for (const [tag, nodeAttrs] of nodes) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(nodeAttrs)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string>>,
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  el.append(...children);
  return el;
}

/** An icon button that doesn't take focus on click (keyboard users can still tab to it). */
function button(
  label: string,
  shortcut: string,
  glyph: IconNode,
  onClick: () => void,
  className = '',
): HTMLButtonElement {
  const title = shortcut ? `${label} (${shortcut})` : label;
  const attrs = { type: 'button', class: className, 'aria-label': label, title };
  const el = element('button', attrs, icon(glyph));
  el.addEventListener('mousedown', (event) => event.preventDefault());
  el.addEventListener('click', onClick);
  return el;
}

// ── Find in selection ────────────────────────────────────────────────────────────────────────

const scopeMark = Decoration.mark({ class: 'cm-findScope' });

const setFindScope = StateEffect.define<readonly { from: number; to: number }[] | null>();

/** The ranges "Find in selection" searches, mapped through edits. */
const findScope = StateField.define<DecorationSet | null>({
  create: () => null,
  update(scope, tr) {
    if (scope && tr.docChanged) scope = scope.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setFindScope)) continue;
      const ranges = effect.value;
      scope =
        ranges &&
        Decoration.set(
          ranges.map((r) => scopeMark.range(r.from, r.to)),
          true,
        );
    }
    return scope;
  },
});

/** The query's `test` while "Find in selection" is on. Ignored once the widget is closed. */
function inFindScope(_match: string, state: EditorState, from: number, to: number): boolean {
  const scope = state.field(findScope, false);
  if (!scope || !searchPanelOpen(state)) return true;
  let inside = false;
  scope.between(from, to, (start, end) => {
    if (start > from || end < to) return;
    inside = true;
    return false;
  });
  return inside;
}

/** Shows the scope while the widget is open. */
const scopeHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = shownScope(view.state);
    }
    update(update: ViewUpdate) {
      this.decorations = shownScope(update.state);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function shownScope(state: EditorState): DecorationSet {
  return (searchPanelOpen(state) && state.field(findScope, false)) || Decoration.none;
}

// ── Queries and matches ──────────────────────────────────────────────────────────────────────

type QueryFields = {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  test: SearchQuery['test'];
};

function withQuery(query: SearchQuery, changes: Partial<QueryFields>): SearchQuery {
  const fields: QueryFields = {
    search: query.search,
    replace: query.replace,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
    test: query.test,
    ...changes,
  };
  // Plain searches are literal (as in VS Code); regexps keep `\n` and `\t` in replacements.
  return new SearchQuery({ ...fields, literal: !fields.regexp });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text Ctrl+F seeds the query with: a short, single-line selection. */
function selectionSeed(state: EditorState): string | null {
  const { main } = state.selection;
  if (main.empty || main.to - main.from > SEED_LIMIT) return null;
  const text = state.sliceDoc(main.from, main.to);
  return /[\r\n]/.test(text) ? null : text;
}

/** The first match at or after `from`, wrapping around to the start. */
function firstMatch(state: EditorState, query: SearchQuery, from: number) {
  let result = query.getCursor(state, from).next();
  if (result.done) result = query.getCursor(state).next();
  return result.done ? null : result.value;
}

interface MatchList {
  doc: Text;
  query: SearchQuery;
  scope: DecorationSet | null;
  froms: number[];
  tos: number[];
  /** More than `MATCH_LIMIT` matches. */
  capped: boolean;
}

function collectMatches(state: EditorState, query: SearchQuery): MatchList {
  const froms: number[] = [];
  const tos: number[] = [];
  let capped = false;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    if (froms.length === MATCH_LIMIT) {
      capped = true;
      break;
    }
    froms.push(next.value.from);
    tos.push(next.value.to);
  }
  const scope = state.field(findScope, false) ?? null;
  return { doc: state.doc, query, scope, froms, tos, capped };
}

/** The 1-based number of the match the selection is on, or 0. */
function matchNumber(list: MatchList, selection: SelectionRange): number {
  let low = 0;
  let high = list.froms.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((list.froms[mid] ?? 0) < selection.from) low = mid + 1;
    else high = mid;
  }
  return list.froms[low] === selection.from && list.tos[low] === selection.to ? low + 1 : 0;
}

/** Reveals a match, centring it when it's off screen (and leaving it be when it isn't). */
function scrollToMatch(range: SelectionRange, view: EditorView): StateEffect<unknown> {
  const visible = view.visibleRanges.some((r) => r.from <= range.from && r.to >= range.to);
  return EditorView.scrollIntoView(range, { y: visible ? 'nearest' : 'center' });
}

/** Marks the selection changes made by find-as-you-type, which keep the search's anchor. */
const typing = Annotation.define<boolean>();

// ── The widget ───────────────────────────────────────────────────────────────────────────────

type Flag = 'caseSensitive' | 'wholeWord' | 'regexp';

/** Alt+C, Alt+W and Alt+R inside the widget. */
const altFlags: Readonly<Partial<Record<string, Flag>>> = {
  c: 'caseSensitive',
  w: 'wholeWord',
  r: 'regexp',
};

const panels = new WeakMap<EditorView, FindPanel>();

/** The letter of a key, layout-independent enough for Alt shortcuts (Alt+C gives "ç" on macOS). */
function keyLetter(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  return /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? '';
}

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private readonly view: EditorView;
  private query: SearchQuery;
  private readonly flags = { caseSensitive: false, wholeWord: false, regexp: false };
  private inSelection = false;
  private replaceShown = false;
  /** Find-as-you-type searches from here: where the selection was before typing moved it. */
  private anchor: number;
  private matches: MatchList | null = null;
  private countTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly findField: HTMLElement;
  private readonly count: HTMLElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly toggles: Record<Flag, HTMLButtonElement>;
  private readonly selectionButton: HTMLButtonElement;
  private readonly navButtons: HTMLButtonElement[];
  private readonly replaceButtons: HTMLButtonElement[];

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.anchor = view.state.selection.main.from;

    this.findInput = element('input', {
      type: 'text',
      class: 'cm-find-input',
      placeholder: 'Find',
      'aria-label': 'Find',
      spellcheck: 'false',
      autocomplete: 'off',
      // Tells @codemirror/search which field to focus and select.
      'main-field': 'true',
    });
    this.replaceInput = element('input', {
      type: 'text',
      class: 'cm-find-input',
      placeholder: 'Replace',
      'aria-label': 'Replace',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    this.findInput.addEventListener('input', () => this.commit(true));
    this.replaceInput.addEventListener('input', () => this.commit(false));

    const toggle = (flag: Flag, label: string, shortcut: string, glyph: IconNode) =>
      button(label, shortcut, glyph, () => this.toggle(flag));
    this.toggles = {
      caseSensitive: toggle('caseSensitive', 'Match case', 'Alt+C', icons.matchCase),
      wholeWord: toggle('wholeWord', 'Match whole word', 'Alt+W', icons.wholeWord),
      regexp: toggle('regexp', 'Use regular expression', 'Alt+R', icons.regexp),
    };
    this.selectionButton = button('Find in selection', 'Alt+L', icons.inSelection, () =>
      this.toggleInSelection(),
    );
    this.navButtons = [
      button('Previous match', 'Shift+Enter', icons.previous, () => findPrevious(view)),
      button('Next match', 'Enter', icons.next, () => findNext(view)),
    ];
    this.replaceButtons = [
      button('Replace', 'Enter', icons.replace, () => replaceNext(view)),
      button('Replace all', 'Ctrl+Alt+Enter', icons.replaceAll, () => replaceAll(view)),
    ];
    this.expandButton = button(
      'Toggle replace',
      '',
      icons.chevron,
      () => this.showReplace(!this.replaceShown),
      'cm-find-expand',
    );
    this.count = element('span', { class: 'cm-find-count', role: 'status', 'aria-live': 'polite' });

    this.findField = element(
      'div',
      { class: 'cm-find-field' },
      this.findInput,
      this.toggles.caseSensitive,
      this.toggles.wholeWord,
      this.toggles.regexp,
    );
    const close = button('Close', 'Escape', icons.close, () => closeSearchPanel(view));
    this.dom = element(
      'div',
      { class: 'cm-find', role: 'search', 'aria-label': 'Find and replace' },
      this.expandButton,
      element(
        'div',
        { class: 'cm-find-grid' },
        this.findField,
        element(
          'div',
          { class: 'cm-find-actions' },
          this.count,
          ...this.navButtons,
          this.selectionButton,
          close,
        ),
        element('div', { class: 'cm-find-field cm-find-replace' }, this.replaceInput),
        element('div', { class: 'cm-find-actions cm-find-replace' }, ...this.replaceButtons),
      ),
    );
    this.dom.addEventListener('keydown', this.onKeyDown);

    this.setQuery(this.query);
    this.syncReadOnly();
    this.refreshCount();
    panels.set(view, this);
  }

  mount() {
    this.focusInput('find');
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value);
      }
      if (tr.docChanged) this.anchor = tr.changes.mapPos(this.anchor);
      if (tr.selection && !tr.annotation(typing)) this.anchor = tr.selection.main.from;
    }
    if (update.state.readOnly !== update.startState.readOnly) this.syncReadOnly();
    if (
      update.docChanged ||
      update.selectionSet ||
      getSearchQuery(update.state) !== getSearchQuery(update.startState) ||
      update.state.field(findScope, false) !== update.startState.field(findScope, false)
    ) {
      this.refreshCount();
    }
  }

  destroy() {
    clearTimeout(this.countTimer);
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  focusInput(which: 'find' | 'replace') {
    const input = which === 'replace' && this.replaceShown ? this.replaceInput : this.findInput;
    input.focus();
    input.select();
  }

  hasFocus(): boolean {
    return this.dom.contains(this.view.root.activeElement);
  }

  showReplace(show: boolean) {
    this.replaceShown = show && !this.view.state.readOnly;
    this.dom.toggleAttribute('data-replace', this.replaceShown);
    this.expandButton.setAttribute('aria-expanded', String(this.replaceShown));
  }

  toggle(flag: Flag) {
    this.flags[flag] = !this.flags[flag];
    this.renderToggles();
    this.commit(true);
  }

  toggleInSelection() {
    let ranges: { from: number; to: number }[] | null = null;
    if (!this.inSelection) {
      ranges = this.view.state.selection.ranges
        .filter((range) => !range.empty)
        .map(({ from, to }) => ({ from, to }));
      // Nothing selected: nothing to search in.
      if (!ranges.length) return;
    }
    this.inSelection = ranges !== null;
    this.renderToggles();
    this.query = this.buildQuery();
    this.view.dispatch({ effects: [setFindScope.of(ranges), setSearchQuery.of(this.query)] });
  }

  private buildQuery(): SearchQuery {
    return withQuery(this.query, {
      search: this.findInput.value,
      replace: this.replaceInput.value,
      ...this.flags,
      test: this.inSelection ? inFindScope : undefined,
    });
  }

  /** Puts the widget's fields into the state; typing in the find field also jumps to a match. */
  private commit(jump: boolean) {
    const query = this.buildQuery();
    if (query.eq(this.query)) return;
    this.query = query;
    const { state } = this.view;
    const match = jump && query.valid ? firstMatch(state, query, this.anchor) : null;
    if (!match) {
      this.view.dispatch({ effects: setSearchQuery.of(query) });
      return;
    }
    const range = EditorSelection.range(match.from, match.to);
    this.view.dispatch({
      selection: EditorSelection.create([range]),
      effects: [setSearchQuery.of(query), scrollToMatch(range, this.view)],
      annotations: typing.of(true),
      userEvent: 'select.search',
    });
  }

  /** Shows a query that came from elsewhere. */
  private setQuery(query: SearchQuery) {
    this.query = query;
    if (this.findInput.value !== query.search) this.findInput.value = query.search;
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    this.flags.caseSensitive = query.caseSensitive;
    this.flags.wholeWord = query.wholeWord;
    this.flags.regexp = query.regexp;
    this.inSelection = query.test === inFindScope;
    this.renderToggles();
  }

  private renderToggles() {
    for (const flag of Object.keys(this.toggles) as Flag[]) {
      this.toggles[flag].setAttribute('aria-pressed', String(this.flags[flag]));
    }
    this.selectionButton.setAttribute('aria-pressed', String(this.inSelection));
  }

  private syncReadOnly() {
    const readOnly = this.view.state.readOnly;
    this.expandButton.disabled = readOnly;
    this.showReplace(this.replaceShown);
    this.renderCount();
  }

  private refreshCount() {
    clearTimeout(this.countTimer);
    const { state } = this.view;
    const query = getSearchQuery(state);
    const known = this.matches;
    const fresh =
      known &&
      known.doc === state.doc &&
      known.query === query &&
      known.scope === (state.field(findScope, false) ?? null);
    if (query.valid && !fresh) {
      if (state.doc.length > SYNC_COUNT_LIMIT) {
        this.countTimer = setTimeout(() => {
          this.matches = collectMatches(this.view.state, getSearchQuery(this.view.state));
          this.renderCount();
        }, COUNT_DELAY);
        return;
      }
      this.matches = collectMatches(state, query);
    }
    this.renderCount();
  }

  private renderCount() {
    const { state } = this.view;
    const query = getSearchQuery(state);
    const list = query.valid && this.matches?.query === query ? this.matches : null;
    const total = list?.froms.length ?? 0;
    let text = '';
    if (list && total) {
      const current = matchNumber(list, state.selection.main);
      text = `${current || '?'} of ${total}${list.capped ? '+' : ''}`;
    } else if (query.search) {
      text = 'No results';
    }
    this.count.textContent = text;
    this.count.toggleAttribute('data-none', text === 'No results');
    const invalid = query.regexp && query.search !== '' && !query.valid;
    this.findField.toggleAttribute('data-invalid', invalid);
    this.findInput.setAttribute('aria-invalid', String(invalid));
    for (const el of this.navButtons) el.disabled = !total;
    for (const el of this.replaceButtons) el.disabled = !total || state.readOnly;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    // Bindings scoped to "search-panel" (findKeymap, searchKeymap) first; then the widget's
    // own keys, so it also works without findKeymap.
    if (runScopeHandlers(this.view, event, 'search-panel') || this.handleKey(event)) {
      event.preventDefault();
    }
  };

  private handleKey(event: KeyboardEvent): boolean {
    const { view } = this;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Enter') {
      if (mod && event.altKey) replaceAll(view);
      else if (event.target === this.findInput) (event.shiftKey ? findPrevious : findNext)(view);
      else if (event.target === this.replaceInput) replaceNext(view);
      else return false;
      return true;
    }
    if (event.key === 'Escape') return closeSearchPanel(view);
    if (event.key === 'F3') {
      (event.shiftKey ? findPrevious : findNext)(view);
      return true;
    }
    const letter = keyLetter(event);
    if (event.altKey && !mod && !event.shiftKey) {
      const flag = altFlags[letter];
      if (flag) this.toggle(flag);
      else if (letter === 'l') this.toggleInSelection();
      else return false;
      return true;
    }
    if (mod && !event.altKey && !event.shiftKey && (letter === 'f' || letter === 'h')) {
      if (letter === 'h') this.showReplace(true);
      this.focusInput(letter === 'h' ? 'replace' : 'find');
      return true;
    }
    return false;
  }
}

// ── Commands and keys ────────────────────────────────────────────────────────────────────────

function openWidget(view: EditorView, withReplace: boolean): boolean {
  const { state } = view;
  const wasOpen = searchPanelOpen(state);
  let query = getSearchQuery(state);
  const effects: StateEffect<unknown>[] = [];
  if (!wasOpen && (query.test === inFindScope || state.field(findScope, false))) {
    // "Find in selection" doesn't outlive the widget.
    query = withQuery(query, { test: undefined });
    effects.push(setFindScope.of(null));
  }
  // Seed from the editor's selection, not when the shortcut is pressed inside the widget.
  const seed = panels.get(view)?.hasFocus() ? null : selectionSeed(state);
  if (seed !== null) query = withQuery(query, { search: query.regexp ? escapeRegExp(seed) : seed });

  if (!wasOpen) openSearchPanel(view);
  // openSearchPanel applies its own idea of the query (multi-line selections included).
  if (!getSearchQuery(view.state).eq(query)) effects.push(setSearchQuery.of(query));
  if (effects.length) view.dispatch({ effects });

  const panel = panels.get(view);
  if (panel) {
    if (withReplace) panel.showReplace(true);
    panel.focusInput(withReplace && query.search ? 'replace' : 'find');
  }
  return true;
}

/** Ctrl+F: opens the find widget, or focuses it, seeding the query from a one-line selection. */
export const openFind: Command = (view) => openWidget(view, false);

/** Ctrl+H: the same, with the replace row shown. */
export const openReplace: Command = (view) => openWidget(view, true);

/** A command that only applies while the widget is open. */
function whenOpen(run: (panel: FindPanel, view: EditorView) => void): Command {
  return (view) => {
    const panel = panels.get(view);
    if (!panel || !searchPanelOpen(view.state)) return false;
    run(panel, view);
    return true;
  };
}

const scope = 'editor search-panel';

/** Find keys, VS Code style. Give them priority over `searchKeymap` (it binds Mod-f too). */
export const findKeymap: KeyBinding[] = [
  { key: 'Mod-f', run: openFind, scope, preventDefault: true },
  { key: 'Mod-h', run: openReplace, scope, preventDefault: true },
  { key: 'F3', run: findNext, scope, preventDefault: true },
  { key: 'Shift-F3', run: findPrevious, scope, preventDefault: true },
  { key: 'Mod-Alt-Enter', run: whenOpen((_, view) => replaceAll(view)), scope },
  { key: 'Escape', run: (view) => searchPanelOpen(view.state) && closeSearchPanel(view), scope },
  { key: 'Alt-c', run: whenOpen((panel) => panel.toggle('caseSensitive')), scope },
  { key: 'Alt-w', run: whenOpen((panel) => panel.toggle('wholeWord')), scope },
  { key: 'Alt-r', run: whenOpen((panel) => panel.toggle('regexp')), scope },
  { key: 'Alt-l', run: whenOpen((panel) => panel.toggleInSelection()), scope },
];

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

const findTheme = EditorView.theme({
  // The panel container floats at the top right instead of pushing the text down. Its height
  // still counts as a scroll margin, so revealed matches never land under the widget.
  '.cm-panels.cm-panels-top:has(> .cm-find:only-child)': {
    position: 'absolute',
    top: '0',
    left: '12px',
    right: '16px',
    display: 'flex',
    justifyContent: 'flex-end',
    background: 'transparent',
    border: 'none',
    pointerEvents: 'none',
  },
  '.cm-find': {
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'stretch',
    gap: '2px',
    width: '420px',
    maxWidth: '100%',
    padding: '4px 4px 4px 2px',
    backgroundColor: 'var(--bg-overlay)',
    color: 'var(--text)',
    border: '1px solid var(--line-strong)',
    borderTop: 'none',
    borderRadius: '0 0 var(--radius) var(--radius)',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    lineHeight: '16px',
    animation: 'cm-find-in var(--dur) var(--ease)',
  },
  '@keyframes cm-find-in': {
    from: { opacity: '0', transform: 'translateY(-4px)' },
    to: { opacity: '1', transform: 'none' },
  },
  '.cm-find-grid': {
    flex: '1 1 auto',
    minWidth: '0',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: '4px',
  },
  '.cm-find:not([data-replace]) .cm-find-replace': { display: 'none' },
  '.cm-find-field': {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    minWidth: '0',
    height: '24px',
    padding: '0 1px 0 0',
    backgroundColor: 'var(--bg)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-sm)',
    transition: 'border-color var(--dur) var(--ease)',
  },
  '.cm-find-field:focus-within': { borderColor: 'var(--focus)' },
  '.cm-find-field[data-invalid]': { borderColor: 'var(--danger)' },
  '.cm-find-input': {
    flex: '1 1 auto',
    minWidth: '0',
    height: '100%',
    boxSizing: 'border-box',
    margin: '0',
    padding: '0 6px',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    userSelect: 'text',
  },
  '.cm-find-input:focus-visible': { outline: 'none' },
  '.cm-find-input::placeholder': { color: 'var(--text-3)' },
  '.cm-find-actions': { display: 'flex', alignItems: 'center', gap: '1px' },
  '.cm-find-count': {
    minWidth: '72px',
    padding: '0 6px 0 4px',
    color: 'var(--text-3)',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-find-count[data-none]': { color: 'var(--danger)' },
  '.cm-find button': {
    appearance: 'none',
    boxSizing: 'border-box',
    display: 'inline-grid',
    placeItems: 'center',
    flex: 'none',
    width: '22px',
    height: '22px',
    margin: '0',
    padding: '0',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: 'transparent',
    color: 'var(--text-2)',
    font: 'inherit',
    cursor: 'default',
    transition: 'background-color var(--dur) var(--ease), color var(--dur) var(--ease)',
  },
  '.cm-find-field button': { width: '20px', height: '20px' },
  '.cm-find button:hover:not(:disabled)': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
  '.cm-find button:active:not(:disabled)': { backgroundColor: 'var(--active)' },
  '.cm-find button[aria-pressed=true]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-fg)',
  },
  '.cm-find button:disabled': { color: 'var(--text-4)' },
  '.cm-find .cm-find-expand': { width: '16px', height: 'auto', alignSelf: 'stretch' },
  '.cm-find-expand svg': { transition: 'transform var(--dur) var(--ease)' },
  '.cm-find-expand[aria-expanded=true] svg': { transform: 'rotate(90deg)' },
  '.cm-find svg': { display: 'block', width: '14px', height: '14px' },
  '.cm-findScope': { backgroundColor: 'var(--hover)' },
});

const findExtension: Extension = [
  search({ top: true, literal: true, createPanel: (view) => new FindPanel(view), scrollToMatch }),
  findScope,
  scopeHighlight,
  findTheme,
];

/** The find widget, replacing @codemirror/search's panel. Pair it with `findKeymap`. */
export function findWidget(): Extension {
  return findExtension;
}
