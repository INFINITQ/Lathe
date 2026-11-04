// Sticky scroll, as in VS Code: while you're scrolled into a class or function, its first line
// (and those of its parents, up to five) stays pinned at the top of the editor, highlighted like
// the code. Clicking one scrolls to it.

import { syntaxTree } from '@codemirror/language';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { highlightTree } from '@lezer/highlight';
import { type DocSymbol, SCOPES, documentSymbols, symbolPath } from './symbols';
import { mono } from './theme';

const MAX_LINES = 5;

class StickyScroll {
  readonly dom: HTMLDivElement;
  private symbols: DocSymbol[] = [];
  private shown = '';
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-sticky';
    this.dom.style.display = 'none';
    this.dom.addEventListener('mousedown', this.onMouseDown);
    view.dom.appendChild(this.dom);
    view.scrollDOM.addEventListener('scroll', this.schedule, { passive: true });
    this.recompute();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.recompute(), 200);
    } else if (update.geometryChanged || update.viewportChanged) {
      this.shown = '';
      this.schedule();
    }
  }

  private recompute() {
    this.symbols = documentSymbols(this.view.state, 20);
    this.shown = '';
    this.schedule();
  }

  private schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  };

  /** The scopes whose first line has scrolled above the top (outermost first). */
  private stack(): DocSymbol[] {
    const { view } = this;
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    if (top <= 0 || !this.symbols.length) return [];
    const { doc } = view.state;
    let stack: DocSymbol[] = [];
    // The pinned lines cover the lines under them, so look again below the ones found so far.
    for (let i = 0; i <= MAX_LINES; i++) {
      const block = view.lineBlockAtHeight(top + stack.length * view.defaultLineHeight);
      const line = doc.lineAt(block.from).number;
      const next = symbolPath(this.symbols, block.from)
        .filter(
          (s) =>
            SCOPES.has(s.kind) &&
            doc.lineAt(s.from).number < line &&
            doc.lineAt(s.to).number > line,
        )
        .slice(0, MAX_LINES);
      const settled = next.length === stack.length;
      stack = next;
      if (settled) break;
    }
    return stack;
  }

  private render() {
    if (!this.view.dom.isConnected) return;
    const stack = this.stack();
    const key = stack.map((s) => s.from).join(',');
    if (key !== this.shown) {
      this.shown = key;
      this.draw(stack);
    }
    this.dom.style.display = stack.length ? '' : 'none';
    const shift = `translateX(${-this.view.scrollDOM.scrollLeft}px)`;
    for (const text of this.dom.querySelectorAll<HTMLElement>('.cm-sticky-text')) {
      text.style.transform = shift;
    }
  }

  private draw(stack: DocSymbol[]) {
    const { view } = this;
    const outer = view.dom.getBoundingClientRect();
    const scroller = view.scrollDOM.getBoundingClientRect();
    const gutter = view.dom.querySelector<HTMLElement>('.cm-gutters')?.offsetWidth ?? 0;
    const fold = view.dom.querySelector<HTMLElement>('.cm-foldGutter')?.offsetWidth ?? 0;
    const firstLine = view.contentDOM.querySelector<HTMLElement>('.cm-line');
    const linePad = firstLine ? parseFloat(getComputedStyle(firstLine).paddingLeft) || 0 : 0;
    const contentLeft =
      view.contentDOM.getBoundingClientRect().left - outer.left + view.scrollDOM.scrollLeft;
    const scrollbar = view.scrollDOM.offsetWidth - view.scrollDOM.clientWidth;
    this.dom.style.left = `${scroller.left - outer.left}px`;
    this.dom.style.right = `${outer.right - scroller.right + scrollbar}px`;
    const height = view.defaultLineHeight;
    this.dom.replaceChildren(
      ...stack.map((symbol, depth) => {
        const line = view.state.doc.lineAt(symbol.from);
        const row = document.createElement('div');
        row.className = 'cm-sticky-line';
        row.dataset.pos = String(line.from);
        row.dataset.depth = String(depth);
        row.style.height = row.style.lineHeight = `${height}px`;
        const number = document.createElement('span');
        number.className = 'cm-sticky-number';
        number.style.width = `${gutter}px`;
        number.style.paddingRight = `${fold + 4}px`;
        number.textContent = gutter ? String(line.number) : '';
        const text = document.createElement('span');
        text.className = 'cm-sticky-text';
        text.style.paddingLeft = `${Math.max(0, contentLeft - gutter - (scroller.left - outer.left)) + linePad}px`;
        let pos = line.from;
        const add = (to: number, classes: string) => {
          if (to <= pos) return;
          const span = document.createElement('span');
          if (classes) span.className = classes;
          span.textContent = line.text.slice(pos - line.from, to - line.from);
          text.appendChild(span);
          pos = to;
        };
        highlightTree(
          syntaxTree(view.state),
          mono,
          (from, to, classes) => {
            add(from, '');
            add(to, classes);
          },
          line.from,
          line.to,
        );
        add(line.to, '');
        row.append(number, text);
        return row;
      }),
    );
  }

  private onMouseDown = (event: MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.cm-sticky-line');
    if (!row) return;
    event.preventDefault();
    const pos = Number(row.dataset.pos);
    const depth = Number(row.dataset.depth);
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, {
        y: 'start',
        yMargin: depth * this.view.defaultLineHeight,
      }),
    });
    this.view.focus();
  };

  destroy() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    this.view.scrollDOM.removeEventListener('scroll', this.schedule);
    this.dom.remove();
  }
}

const theme = EditorView.baseTheme({
  '.cm-sticky': {
    position: 'absolute',
    top: '0',
    zIndex: '3',
    overflow: 'hidden',
    cursor: 'pointer',
    backgroundColor: 'var(--bg)',
    borderBottom: '1px solid var(--line)',
    boxShadow: '0 3px 6px -4px rgb(0 0 0 / 0.45)',
    fontFamily: 'var(--font-code)',
    fontSize: 'var(--code-size)',
    fontVariantLigatures: 'var(--code-ligatures)',
  },
  '.cm-sticky-line': { display: 'flex', whiteSpace: 'pre' },
  '.cm-sticky-line:hover': { backgroundColor: 'var(--hover)' },
  '.cm-sticky-number': {
    flexShrink: '0',
    boxSizing: 'border-box',
    textAlign: 'right',
    color: 'var(--text-4)',
    backgroundColor: 'inherit',
    position: 'relative',
    zIndex: '1',
  },
  '.cm-sticky-text': { color: 'var(--code-fg)' },
});

export function stickyScroll() {
  return [ViewPlugin.fromClass(StickyScroll), theme];
}
