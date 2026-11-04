import { SearchQuery, getSearchQuery, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { findKeymap, findWidget, openFind, openReplace } from './find';

let view: EditorView | null = null;

function setup(doc: string, selection?: { anchor: number; head?: number }, keys = true) {
  const extensions: Extension[] = [findWidget()];
  if (keys) extensions.push(keymap.of(findKeymap));
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, selection, extensions }),
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

const widget = (v: EditorView) => v.dom.querySelector<HTMLElement>('.cm-find');

function part<T extends Element>(v: EditorView, selector: string): T {
  const el = widget(v)?.querySelector<T>(selector);
  if (!el) throw new Error(`No ${selector} in the find widget`);
  return el;
}

const findInput = (v: EditorView) => part<HTMLInputElement>(v, 'input[aria-label="Find"]');
const replaceInput = (v: EditorView) => part<HTMLInputElement>(v, 'input[aria-label="Replace"]');
const control = (v: EditorView, label: string) =>
  part<HTMLButtonElement>(v, `button[aria-label="${label}"]`);
const count = (v: EditorView) => part<HTMLElement>(v, '.cm-find-count').textContent;
const selected = (v: EditorView) => [v.state.selection.main.from, v.state.selection.main.to];
const pressed = (v: EditorView, label: string) => control(v, label).getAttribute('aria-pressed');

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('find widget', () => {
  it('opens as a top panel with the find field focused', () => {
    const v = setup('one two');
    openFind(v);
    expect(searchPanelOpen(v.state)).toBe(true);
    expect(widget(v)?.parentElement?.classList.contains('cm-panels-top')).toBe(true);
    expect(document.activeElement).toBe(findInput(v));
    for (const el of widget(v)?.querySelectorAll('button, input') ?? []) {
      expect(el.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('counts matches as "n of total" and jumps to the first one while typing', () => {
    const v = setup('foo bar foo baz foo');
    openFind(v);
    type(findInput(v), 'foo');
    expect(count(v)).toBe('1 of 3');
    expect(selected(v)).toEqual([0, 3]);
    v.dispatch({ selection: { anchor: 5 } });
    expect(count(v)).toBe('? of 3');
    type(findInput(v), 'qux');
    expect(count(v)).toBe('No results');
    type(findInput(v), '');
    expect(count(v)).toBe('');
  });

  it('caps the count at 10000', () => {
    const v = setup('a '.repeat(10_050));
    openFind(v);
    type(findInput(v), 'a');
    expect(count(v)).toBe('1 of 10000+');
  });

  it('updates the query from the toggles', () => {
    const v = setup('Foo foo food');
    openFind(v);
    type(findInput(v), 'foo');
    expect(count(v)).toBe('1 of 3');

    control(v, 'Match case').click();
    expect(getSearchQuery(v.state).caseSensitive).toBe(true);
    expect(pressed(v, 'Match case')).toBe('true');
    expect(count(v)).toBe('1 of 2');
    expect(selected(v)).toEqual([4, 7]);

    press(findInput(v), 'w', { altKey: true });
    expect(getSearchQuery(v.state).wholeWord).toBe(true);
    expect(pressed(v, 'Match whole word')).toBe('true');
    expect(count(v)).toBe('1 of 1');

    press(findInput(v), 'r', { altKey: true });
    expect(getSearchQuery(v.state).regexp).toBe(true);
    expect(pressed(v, 'Use regular expression')).toBe('true');

    type(findInput(v), 'fo+(');
    expect(count(v)).toBe('No results');
    expect(findInput(v).getAttribute('aria-invalid')).toBe('true');

    control(v, 'Match case').click();
    expect(getSearchQuery(v.state).caseSensitive).toBe(false);
    expect(pressed(v, 'Match case')).toBe('false');
  });

  it('moves the selection with next and previous', () => {
    const v = setup('foo bar foo baz foo');
    openFind(v);
    type(findInput(v), 'foo');
    press(findInput(v), 'Enter');
    expect(selected(v)).toEqual([8, 11]);
    expect(count(v)).toBe('2 of 3');
    control(v, 'Next match').click();
    expect(selected(v)).toEqual([16, 19]);
    press(findInput(v), 'Enter', { shiftKey: true });
    expect(selected(v)).toEqual([8, 11]);
    control(v, 'Previous match').click();
    expect(selected(v)).toEqual([0, 3]);
    press(v.contentDOM, 'F3');
    expect(selected(v)).toEqual([8, 11]);
    press(v.contentDOM, 'F3', { shiftKey: true });
    expect(selected(v)).toEqual([0, 3]);
  });

  it('replaces the current match, then all of them', () => {
    const v = setup('foo bar foo baz foo');
    openReplace(v);
    type(findInput(v), 'foo');
    type(replaceInput(v), 'X');
    press(replaceInput(v), 'Enter');
    expect(v.state.doc.toString()).toBe('X bar foo baz foo');
    expect(count(v)).toBe('1 of 2');
    control(v, 'Replace').click();
    expect(v.state.doc.toString()).toBe('X bar X baz foo');
    control(v, 'Replace all').click();
    expect(v.state.doc.toString()).toBe('X bar X baz X');
    expect(count(v)).toBe('No results');
  });

  it('replaces all with Ctrl+Alt+Enter, from the widget or the editor', () => {
    const v = setup('a-a-a');
    openReplace(v);
    type(findInput(v), 'a');
    type(replaceInput(v), 'b');
    press(findInput(v), 'Enter', { ctrlKey: true, altKey: true });
    expect(v.state.doc.toString()).toBe('b-b-b');
    type(findInput(v), 'b');
    type(replaceInput(v), 'c');
    press(v.contentDOM, 'Enter', { ctrlKey: true, altKey: true });
    expect(v.state.doc.toString()).toBe('c-c-c');
  });

  it('closes on Escape, and leaves Escape alone once closed', () => {
    const v = setup('foo');
    openFind(v);
    press(findInput(v), 'Escape');
    expect(searchPanelOpen(v.state)).toBe(false);
    expect(widget(v)).toBeNull();

    openFind(v);
    expect(press(v.contentDOM, 'Escape').defaultPrevented).toBe(true);
    expect(searchPanelOpen(v.state)).toBe(false);
    expect(press(v.contentDOM, 'Escape').defaultPrevented).toBe(false);

    openFind(v);
    control(v, 'Close').click();
    expect(searchPanelOpen(v.state)).toBe(false);
  });

  it('seeds the query from a single-line selection on Ctrl+F', () => {
    const v = setup('alpha beta\ngamma', { anchor: 6, head: 10 });
    press(v.contentDOM, 'f', { ctrlKey: true });
    expect(findInput(v).value).toBe('beta');
    expect(count(v)).toBe('1 of 1');

    // Pressed again while open: focuses and selects the input.
    findInput(v).setSelectionRange(2, 2);
    press(findInput(v), 'f', { ctrlKey: true });
    expect(document.activeElement).toBe(findInput(v));
    expect([findInput(v).selectionStart, findInput(v).selectionEnd]).toEqual([0, 4]);

    // A multi-line selection keeps the previous query.
    press(findInput(v), 'Escape');
    v.dispatch({ selection: { anchor: 0, head: 13 } });
    press(v.contentDOM, 'f', { ctrlKey: true });
    expect(findInput(v).value).toBe('beta');
  });

  it('escapes the seed in regular expression mode', () => {
    const v = setup('a.b axb', { anchor: 0, head: 3 });
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'x', regexp: true })) });
    openFind(v);
    expect(findInput(v).value).toBe('a\\.b');
    expect(count(v)).toBe('1 of 1');
  });

  it('opens with the replace row on Ctrl+H', () => {
    const v = setup('foo');
    press(v.contentDOM, 'h', { ctrlKey: true });
    expect(searchPanelOpen(v.state)).toBe(true);
    expect(widget(v)?.hasAttribute('data-replace')).toBe(true);
    expect(control(v, 'Toggle replace').getAttribute('aria-expanded')).toBe('true');
    control(v, 'Toggle replace').click();
    expect(widget(v)?.hasAttribute('data-replace')).toBe(false);

    type(findInput(v), 'foo');
    press(findInput(v), 'h', { ctrlKey: true });
    expect(widget(v)?.hasAttribute('data-replace')).toBe(true);
    expect(document.activeElement).toBe(replaceInput(v));
  });

  it('reflects query changes made elsewhere', () => {
    const v = setup('foo Bar bar');
    openFind(v);
    const query = new SearchQuery({ search: 'bar', caseSensitive: true, replace: 'x' });
    v.dispatch({ effects: setSearchQuery.of(query) });
    expect(findInput(v).value).toBe('bar');
    expect(replaceInput(v).value).toBe('x');
    expect(pressed(v, 'Match case')).toBe('true');
    expect(pressed(v, 'Use regular expression')).toBe('false');
    expect(count(v)).toBe('? of 1');
  });

  it('finds in the selection only', () => {
    const v = setup('foo\nfoo\nfoo', { anchor: 0, head: 7 });
    openReplace(v);
    control(v, 'Find in selection').click();
    expect(pressed(v, 'Find in selection')).toBe('true');
    expect(v.contentDOM.querySelector('.cm-findScope')).not.toBeNull();
    type(findInput(v), 'foo');
    expect(count(v)).toBe('1 of 2');
    type(replaceInput(v), 'X');
    control(v, 'Replace all').click();
    expect(v.state.doc.toString()).toBe('X\nX\nfoo');

    press(findInput(v), 'l', { altKey: true });
    expect(pressed(v, 'Find in selection')).toBe('false');
    type(findInput(v), 'X');
    expect(count(v)).toBe('1 of 2');
  });

  it('does not search in an empty selection', () => {
    const v = setup('foo foo');
    openFind(v);
    control(v, 'Find in selection').click();
    expect(pressed(v, 'Find in selection')).toBe('false');
    expect(getSearchQuery(v.state).test).toBeUndefined();
  });

  it('works without findKeymap', () => {
    const v = setup('foo Foo foo', undefined, false);
    openFind(v);
    type(findInput(v), 'foo');
    press(findInput(v), 'c', { altKey: true });
    expect(getSearchQuery(v.state).caseSensitive).toBe(true);
    expect(selected(v)).toEqual([0, 3]);
    press(findInput(v), 'Enter');
    expect(selected(v)).toEqual([8, 11]);
    press(findInput(v), 'F3', { shiftKey: true });
    expect(selected(v)).toEqual([0, 3]);
    press(findInput(v), 'Escape');
    expect(searchPanelOpen(v.state)).toBe(false);
  });

  it('keeps the replace row closed in read-only editors', () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: 'foo',
        extensions: [findWidget(), keymap.of(findKeymap), EditorState.readOnly.of(true)],
      }),
    });
    openReplace(view);
    expect(widget(view)?.hasAttribute('data-replace')).toBe(false);
    expect(control(view, 'Toggle replace').disabled).toBe(true);
  });
});
