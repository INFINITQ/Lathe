import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLineRuns,
  minimap,
  minimapLayout,
  minimapLineAt,
  minimapScrollTarget,
  parseCssColor,
  rowMetrics,
  type MinimapMetrics,
} from './minimap';

/** A 600 px minimap at 2 px per line, so it fits 300 lines. */
function metrics(overrides: Partial<MinimapMetrics> = {}): MinimapMetrics {
  return {
    lineCount: 100,
    topLine: 0,
    bottomLine: 30,
    scrollTop: 0,
    maxScrollTop: 1400,
    height: 600,
    lineHeight: 2,
    ...overrides,
  };
}

describe('minimapLayout', () => {
  it('draws a short document from the top and moves the slider with the viewport', () => {
    const layout = minimapLayout(metrics({ topLine: 20, bottomLine: 50, scrollTop: 400 }));
    expect(layout).toEqual({
      offset: 0,
      sliderTop: 40,
      sliderHeight: 60,
      firstLine: 0,
      lastLine: 99,
    });
  });

  it('scrolls a long document proportionally, keeping the slider on the visible lines', () => {
    const long = { lineCount: 10_000, maxScrollTop: 1_000_000 };
    const top = minimapLayout(metrics(long));
    expect(top).toEqual({ offset: 0, sliderTop: 0, sliderHeight: 60, firstLine: 0, lastLine: 299 });

    const middle = minimapLayout(
      metrics({ ...long, topLine: 4985, bottomLine: 5015, scrollTop: 500_000 }),
    );
    expect(middle.sliderTop).toBeCloseTo(270); // halfway along the 540 px it can travel
    expect(middle.offset).toBeCloseTo(4985 * 2 - 270);
    expect(middle.firstLine).toBe(Math.floor(middle.offset / 2));
    expect(middle.lastLine - middle.firstLine).toBeLessThanOrEqual(300);

    const bottom = minimapLayout(
      metrics({ ...long, topLine: 9970, bottomLine: 10_000, scrollTop: 1_000_000 }),
    );
    expect(bottom.offset).toBe(20_000 - 600);
    expect(bottom.sliderTop + bottom.sliderHeight).toBe(600);
    expect(bottom.lastLine).toBe(9999);
  });

  it('keeps the slider inside the minimap when scrolled past the last line', () => {
    const layout = minimapLayout(
      metrics({
        lineCount: 10_000,
        topLine: 9990,
        bottomLine: 10_020,
        scrollTop: 1e6,
        maxScrollTop: 1e6,
      }),
    );
    expect(layout.sliderHeight).toBe(20);
    expect(layout.sliderTop + layout.sliderHeight).toBeLessThanOrEqual(600);
  });

  it('gives the slider a minimum height', () => {
    // One long wrapped line fills the viewport.
    expect(minimapLayout(metrics({ topLine: 3, bottomLine: 3.2 })).sliderHeight).toBe(8);
  });
});

describe('minimap scroll mapping', () => {
  it('maps a slider position to a scroll ratio when the minimap scrolls itself', () => {
    const m = metrics({ lineCount: 10_000, maxScrollTop: 1_000_000 });
    const layout = minimapLayout(m);
    expect(minimapScrollTarget(m, layout, 270)).toEqual({ ratio: 0.5 });
    expect(minimapScrollTarget(m, layout, -50)).toEqual({ ratio: 0 });
    expect(minimapScrollTarget(m, layout, 9999)).toEqual({ ratio: 1 });
  });

  it('round-trips with the layout', () => {
    const lineCount = 10_000;
    const maxScrollTop = (lineCount - 30) * 20;
    for (const ratio of [0, 0.25, 0.5, 0.9, 1]) {
      const topLine = ratio * (lineCount - 30);
      const m = metrics({
        lineCount,
        topLine,
        bottomLine: topLine + 30,
        scrollTop: ratio * maxScrollTop,
        maxScrollTop,
      });
      const layout = minimapLayout(m);
      const target = minimapScrollTarget(m, layout, layout.sliderTop);
      expect('ratio' in target && target.ratio).toBeCloseTo(ratio);
    }
  });

  it('maps a slider position to a line when the whole document fits', () => {
    const m = metrics();
    expect(minimapScrollTarget(m, minimapLayout(m), 20)).toEqual({ line: 10 });
  });

  it('finds the line under a point', () => {
    const m = metrics({
      lineCount: 10_000,
      topLine: 4985,
      bottomLine: 5015,
      scrollTop: 5e5,
      maxScrollTop: 1e6,
    });
    const layout = minimapLayout(m);
    expect(minimapLineAt(m, layout, 100)).toBeCloseTo((layout.offset + 100) / 2);
    expect(minimapLineAt(m, layout, -1e9)).toBe(0);
    expect(minimapLineAt(metrics(), minimapLayout(metrics()), 1e9)).toBe(100);
  });
});

describe('rowMetrics', () => {
  it('snaps rows to whole device pixels', () => {
    expect(rowMetrics(1)).toEqual({ rowPx: 2, blockPx: 1, lineHeight: 2 });
    expect(rowMetrics(1.25)).toEqual({ rowPx: 3, blockPx: 2, lineHeight: 2.4 });
    expect(rowMetrics(1.5)).toEqual({ rowPx: 3, blockPx: 2, lineHeight: 2 });
    expect(rowMetrics(2)).toEqual({ rowPx: 4, blockPx: 3, lineHeight: 2 });
  });
});

describe('buildLineRuns', () => {
  it('skips whitespace and merges characters of the same style', () => {
    expect(buildLineRuns('ab  cd', [], 4, 90)).toEqual([0, 2, 0, 4, 6, 0]);
    expect(buildLineRuns('abc', [0, 1, 1, 1, 3, 1], 4, 90)).toEqual([0, 3, 1]);
  });

  it('colours characters from the highlight spans', () => {
    expect(buildLineRuns('let x = 1', [0, 3, 1, 4, 5, 2, 8, 9, 3], 4, 90)).toEqual([
      0, 3, 1, 4, 5, 2, 6, 7, 0, 8, 9, 3,
    ]);
  });

  it('expands tabs to the next tab stop', () => {
    expect(buildLineRuns('\tx', [], 4, 90)).toEqual([4, 5, 0]);
    expect(buildLineRuns('ab\tc', [], 4, 90)).toEqual([0, 2, 0, 4, 5, 0]);
  });

  it('stops at the last column and counts a surrogate pair once', () => {
    expect(buildLineRuns('abcdef', [], 4, 3)).toEqual([0, 3, 0]);
    expect(buildLineRuns('😀a', [], 4, 90)).toEqual([0, 2, 0]);
  });
});

describe('parseCssColor', () => {
  it('reads computed colours', () => {
    expect(parseCssColor('rgb(212, 212, 216)')).toEqual([212, 212, 216, 1]);
    expect(parseCssColor('rgba(217, 249, 157, 0.1)')).toEqual([217, 249, 157, 0.1]);
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual([10, 20, 30, 0.5]);
    expect(parseCssColor('#d9f99d')).toEqual([217, 249, 157, 1]);
    expect(parseCssColor('#FFF')).toEqual([255, 255, 255, 1]);
  });

  it('rejects anything else', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('var(--syn-keyword)')).toBeNull();
    expect(parseCssColor('rgb(1, 2)')).toBeNull();
  });
});

describe('minimap extension', () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const marginsOf = (v: EditorView) =>
    v.state.facet(EditorView.scrollMargins).map((margins) => margins(v));

  it('adds a column to the scroller and removes it again', () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'one\ntwo', extensions: minimap() }),
    });
    const dom = view.scrollDOM.querySelector('.cm-minimap');
    expect(dom?.getAttribute('aria-hidden')).toBe('true');
    expect(dom?.querySelector('canvas')).not.toBeNull();
    view.destroy();
    expect(view.scrollDOM.querySelector('.cm-minimap')).toBeNull();
    view = null;
  });

  it('hides itself in a narrow editor', async () => {
    // jsdom has no layout, so the editor measures 0 px wide.
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: 'one\ntwo', extensions: minimap() }),
    });
    await frame();
    expect(
      view.scrollDOM.querySelector('.cm-minimap')?.classList.contains('cm-minimap-hidden'),
    ).toBe(true);
    expect(marginsOf(view)).toContain(null);
  });

  it('draws the visible lines and shows the slider when the editor scrolls', async () => {
    // jsdom has neither layout nor canvas: fake the sizes and a 2D context.
    let image: ImageData | null = null;
    const context = {
      createImageData: (width: number, height: number) =>
        ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
      putImageData: (data: ImageData) => {
        image = data;
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => context as unknown as CanvasRenderingContext2D,
    );
    const fake = (el: Element, sizes: Record<string, number>) => {
      for (const [name, value] of Object.entries(sizes)) {
        Object.defineProperty(el, name, { configurable: true, get: () => value });
      }
    };

    const doc = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, extensions: minimap() }),
    });
    const dom = view.scrollDOM.querySelector<HTMLElement>('.cm-minimap');
    if (!dom) throw new Error('No minimap');
    fake(view.dom, { clientWidth: 900 });
    fake(view.scrollDOM, {
      clientHeight: 600,
      scrollHeight: 40_000,
      clientWidth: 900,
      scrollWidth: 900,
    });
    fake(dom, { clientWidth: 96, clientHeight: 600 });
    view.requestMeasure();
    await frame();
    await frame();

    expect(dom.classList.contains('cm-minimap-hidden')).toBe(false);
    const slider = dom.querySelector<HTMLElement>('.cm-minimap-slider');
    expect(slider?.style.display).toBe('');
    expect(parseFloat(slider?.style.height ?? '')).toBeGreaterThan(0);
    expect(marginsOf(view)).toContainEqual({ right: 96 });

    // "line 0" at 1 px per character after a 6 px inset, one 1 px block per 2 px row.
    const drawn = image as ImageData | null;
    if (!drawn) throw new Error('Nothing drawn');
    const alpha = (x: number, y: number) => drawn.data[(y * drawn.width + x) * 4 + 3];
    expect([drawn.width, drawn.height]).toEqual([96, 600]);
    expect(alpha(6, 0)).toBeGreaterThan(0); // "l"
    expect(alpha(10, 0)).toBe(0); // the space
    expect(alpha(11, 0)).toBeGreaterThan(0); // "0"
    expect(alpha(2, 0)).toBe(0); // the inset
    expect(alpha(6, 1)).toBe(0); // the gap between rows
    expect(alpha(6, 2)).toBeGreaterThan(0); // "line 1"
  });
});
