// A VS Code-style minimap: every line drawn as tiny blocks coloured by syntax, with a slider for
// the part on screen. It lives inside the scroller as a sticky column after the content, so text
// reflows around it (nothing ever sits under it), the native scrollbar stays at the far right and
// the wheel scrolls the editor without any help.

import { highlightingFor, syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { highlightTree, type Highlighter } from '@lezer/highlight';

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = ReturnType<Tree['resolveInner']>;
type Rgba = readonly [number, number, number, number];

/** Width of the minimap column, in CSS pixels. */
const WIDTH = 96;
/** Narrower editors hide the minimap. */
const MIN_EDITOR_WIDTH = 500;
/** Text starts this far from the left edge; one CSS pixel per character after that. */
const PAD_LEFT = 6;
const PAD_RIGHT = 4;
const MAX_COLUMNS = WIDTH - PAD_LEFT - PAD_RIGHT;
const MIN_SLIDER = 8;
const PLAIN_ALPHA = 0.45;
const SYNTAX_ALPHA = 0.8;
/** Distinct lines kept in the render cache. */
const CACHE_LIMIT = 8000;
const FALLBACK_COLOR: Rgba = [128, 128, 128, 1];
const NO_RUNS: readonly number[] = [];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// ── Pure helpers (exported for tests) ────────────────────────────────────────────────────────

/** What the minimap needs to know about the editor; lengths in CSS pixels. */
export interface MinimapMetrics {
  lineCount: number;
  /** Fractional, 0-based document line at the top and the bottom of the editor's viewport. */
  topLine: number;
  bottomLine: number;
  scrollTop: number;
  maxScrollTop: number;
  /** The minimap's height, and the height of one line in it. */
  height: number;
  lineHeight: number;
}

export interface MinimapLayout {
  /** How far the minimap's own content is scrolled (when the document is taller than it). */
  offset: number;
  sliderTop: number;
  sliderHeight: number;
  /** 0-based lines that are at least partly visible in the minimap. */
  firstLine: number;
  lastLine: number;
}

/**
 * Where the slider goes and which lines to draw. When the document is taller than the minimap,
 * the slider travels the full height as the editor scrolls from top to bottom, and the drawn
 * lines scroll underneath it so it always covers the lines that are on screen.
 */
export function minimapLayout(m: MinimapMetrics): MinimapLayout {
  const total = m.lineCount * m.lineHeight;
  const top = clamp(m.topLine, 0, m.lineCount);
  const bottom = clamp(m.bottomLine, top, m.lineCount);
  const sliderHeight = clamp(
    (bottom - top) * m.lineHeight,
    Math.min(MIN_SLIDER, m.height),
    m.height,
  );
  let offset = 0;
  if (total > m.height) {
    const ratio = m.maxScrollTop > 0 ? clamp(m.scrollTop / m.maxScrollTop, 0, 1) : 0;
    offset = clamp(top * m.lineHeight - ratio * (m.height - sliderHeight), 0, total - m.height);
  }
  const sliderTop = clamp(top * m.lineHeight - offset, 0, Math.max(0, m.height - sliderHeight));
  const firstLine = Math.floor(offset / m.lineHeight);
  const lastLine = Math.min(m.lineCount, Math.ceil((offset + m.height) / m.lineHeight)) - 1;
  return { offset, sliderTop, sliderHeight, firstLine, lastLine };
}

/**
 * Where to scroll so the slider's top lands at `sliderTop`: a fraction of the editor's scroll
 * range when the minimap scrolls itself, otherwise the (fractional) line to show at the top.
 */
export type MinimapTarget = { ratio: number } | { line: number };

export function minimapScrollTarget(
  m: MinimapMetrics,
  layout: MinimapLayout,
  sliderTop: number,
): MinimapTarget {
  if (m.lineCount * m.lineHeight > m.height) {
    const room = m.height - layout.sliderHeight;
    return { ratio: room > 0 ? clamp(sliderTop / room, 0, 1) : 0 };
  }
  return { line: clamp(sliderTop / m.lineHeight, 0, m.lineCount) };
}

/** The fractional, 0-based line under a point `y` pixels below the minimap's top. */
export function minimapLineAt(m: MinimapMetrics, layout: MinimapLayout, y: number): number {
  return clamp((y + layout.offset) / m.lineHeight, 0, m.lineCount);
}

/**
 * Device-pixel geometry of one minimap row: about 2 CSS px per line, snapped to whole device
 * pixels so rows stay crisp at any scale. `lineHeight` is the snapped row height in CSS px.
 */
export function rowMetrics(dpr: number): { rowPx: number; blockPx: number; lineHeight: number } {
  const rowPx = Math.max(2, Math.round(2 * dpr));
  const blockPx = rowPx - Math.max(1, Math.round(rowPx / 3));
  return { rowPx, blockPx, lineHeight: rowPx / dpr };
}

/**
 * A line as runs of visible characters: flat `[startColumn, endColumn, style]` triples. Tabs
 * expand to the next tab stop and whitespace is skipped. `spans` are flat `[from, to, style]`
 * triples (offsets into `text`, in order); characters outside them get style 0.
 */
export function buildLineRuns(
  text: string,
  spans: readonly number[],
  tabSize: number,
  maxColumns: number,
): number[] {
  const runs: number[] = [];
  const tab = Math.max(1, tabSize);
  let column = 0;
  let span = 0;
  for (let i = 0; i < text.length && column < maxColumns; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) {
      column += tab - (column % tab);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue; // second half of a surrogate pair
    if (code <= 32 || code === 160 || code === 0x3000) {
      column++;
      continue;
    }
    while (span < spans.length && (spans[span + 1] ?? 0) <= i) span += 3;
    const style = span < spans.length && (spans[span] ?? 0) <= i ? (spans[span + 2] ?? 0) : 0;
    const last = runs.length - 3;
    if (last >= 0 && runs[last + 1] === column && runs[last + 2] === style)
      runs[last + 1] = column + 1;
    else runs.push(column, column + 1, style);
    column++;
  }
  return runs;
}

/** Parses a computed CSS colour (`rgb()`, `rgba()` or hex) into `[r, g, b, a]`. */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text)?.[1];
  if (hex) {
    const digits = hex.length <= 4 ? [...hex].map((d) => d + d) : (hex.match(/../g) ?? []);
    const [r = 0, g = 0, b = 0, a = 255] = digits.map((d) => parseInt(d, 16));
    return [r, g, b, a / 255];
  }
  const args = /^rgba?\(([^)]*)\)$/.exec(text)?.[1];
  if (!args) return null;
  const parts = args.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const number = (part: string, scale: number) =>
    part.endsWith('%') ? (parseFloat(part) / 100) * scale : parseFloat(part);
  const [r, g, b] = parts.slice(0, 3).map((part) => clamp(Math.round(number(part, 255)), 0, 255));
  const a = clamp(parts[3] === undefined ? 1 : number(parts[3], 1), 0, 1);
  if (r === undefined || g === undefined || b === undefined) return null;
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return [r, g, b, a];
}

// ── The view plugin ──────────────────────────────────────────────────────────────────────────

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** A colour as one ImageData pixel (RGBA bytes read as a native-endian uint32). */
function pack([r, g, b, a]: Rgba, alpha: number): number {
  const opacity = Math.round(clamp(a * alpha, 0, 1) * 255);
  return littleEndian
    ? ((opacity << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | opacity) >>> 0;
}

/** The fractional, 0-based line at a height measured from the top of the document. */
function lineAtHeight(view: EditorView, height: number): number {
  const { doc } = view.state;
  const block = view.lineBlockAtHeight(height);
  const first = doc.lineAt(block.from).number - 1;
  const last = doc.lineAt(block.to).number - 1;
  const fraction = block.height > 0 ? clamp((height - block.top) / block.height, 0, 1) : 0;
  return first + fraction * (last - first + 1);
}

/**
 * The syntax context a line starts in (the node types around its first character). Together
 * with the line's text it decides the line's colours, so it keys the render cache: typing only
 * re-highlights lines whose text or context changed, such as those after an opened comment.
 */
function contextKey(tree: Tree, pos: number): string {
  let key = '';
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    key += `${node.type.id},`;
  }
  return key;
}

interface Measurement {
  visible: boolean;
  width: number;
  dpr: number;
  metrics: MinimapMetrics | null;
  /** The scrollTop that puts the top of the document at the top of the viewport. */
  contentOffset: number;
  clientHeight: number;
  /** Long lines currently run under the minimap. */
  overlap: boolean;
}

const hidden: Measurement = {
  visible: false,
  width: 0,
  dpr: 1,
  metrics: null,
  contentOffset: 0,
  clientHeight: 0,
  overlap: false,
};

const preventDefault = (event: Event) => event.preventDefault();

class MinimapView implements PluginValue {
  readonly dom = document.createElement('div');
  /** Whether the minimap is shown; it hides itself in narrow editors. */
  visible = true;

  private readonly view: EditorView;
  private readonly canvas = document.createElement('canvas');
  private readonly slider = document.createElement('div');
  /** Resolves highlight classes to colours through the real stylesheet. */
  private readonly probe = document.createElement('span');
  private readonly themeObserver: MutationObserver;
  private readonly highlighter: Highlighter;
  private readonly measureRequest = {
    key: this,
    read: (view: EditorView) => this.read(view),
    write: (measurement: Measurement) => this.write(measurement),
  };

  private metrics: MinimapMetrics | null = null;
  private layout: MinimapLayout | null = null;
  private contentOffset = 0;
  private clientHeight = 0;

  private tree: Tree;
  /** Render data per (context, line text); see `contextKey`. */
  private readonly runsCache = new Map<string, number[]>();
  /** Cache keys of the lines seen with the current document and tree. */
  private lineKeys = new Map<number, string>();
  private readonly styleIds = new Map<string, number>([['', 0]]);
  private readonly styles: string[] = [''];
  private colors: number[] = [];
  private plainColor: Rgba | null = null;
  /** Bumps whenever the drawn content may differ; part of the canvas signature. */
  private version = 0;
  private drawn = '';

  private context: CanvasRenderingContext2D | null | undefined;
  private image: ImageData | null = null;
  private pixels: Uint32Array | null = null;
  private drag: { pointerId: number; grab: number; top: number } | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.tree = syntaxTree(view.state);
    this.highlighter = { style: (tags) => highlightingFor(this.view.state, tags) };

    this.dom.className = 'cm-minimap';
    this.dom.setAttribute('aria-hidden', 'true');
    this.slider.className = 'cm-minimap-slider';
    this.probe.className = 'cm-minimap-probe';
    this.dom.append(this.slider, this.canvas, this.probe);
    view.scrollDOM.appendChild(this.dom);

    // Clicks must not move focus out of the editor (the scroller itself is focusable).
    this.dom.addEventListener('mousedown', preventDefault);
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    this.dom.addEventListener('pointermove', this.onPointerMove);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
    view.scrollDOM.addEventListener('scroll', this.schedule, { passive: true });

    this.themeObserver = new MutationObserver(() => {
      this.colors = [];
      this.plainColor = null;
      this.version++;
      this.schedule();
    });
    this.themeObserver.observe(view.dom.ownerDocument.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });
    this.schedule();
  }

  update(update: ViewUpdate) {
    const tree = syntaxTree(update.state);
    const reconfigured = update.transactions.some((tr) => tr.reconfigured);
    if (reconfigured) {
      // Highlighters, tab size or theme may have changed.
      this.runsCache.clear();
      this.colors = [];
      this.plainColor = null;
    }
    if (update.docChanged || tree !== this.tree || reconfigured) {
      this.tree = tree;
      this.lineKeys = new Map();
      this.version++;
      this.schedule();
    } else if (update.viewportChanged || update.geometryChanged || update.heightChanged) {
      this.schedule();
    }
  }

  destroy() {
    this.themeObserver.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.schedule);
    this.dom.remove();
  }

  /** Redraws on the next animation frame (CodeMirror batches measure requests per frame). */
  private readonly schedule = () => this.view.requestMeasure(this.measureRequest);

  private read(view: EditorView): Measurement {
    if (view.dom.clientWidth < MIN_EDITOR_WIDTH) return hidden;
    const scroller = view.scrollDOM;
    const clientHeight = scroller.clientHeight;
    // Where line 1 starts, relative to the top of the viewport.
    const docTop = view.documentTop - scroller.getBoundingClientRect().top - scroller.clientTop;
    const dpr = window.devicePixelRatio || 1;
    return {
      visible: true,
      width: this.dom.clientWidth,
      dpr,
      metrics: {
        lineCount: view.state.doc.lines,
        topLine: lineAtHeight(view, -docTop),
        bottomLine: lineAtHeight(view, clientHeight - docTop),
        scrollTop: scroller.scrollTop,
        maxScrollTop: Math.max(0, scroller.scrollHeight - clientHeight),
        height: this.dom.clientHeight,
        lineHeight: rowMetrics(dpr).lineHeight,
      },
      contentOffset: scroller.scrollTop + docTop,
      clientHeight,
      overlap: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
    };
  }

  private write(measurement: Measurement) {
    if (measurement.visible !== this.visible) {
      this.visible = measurement.visible;
      this.dom.classList.toggle('cm-minimap-hidden', !this.visible);
      // Once shown it has a size to measure.
      if (this.visible) this.schedule();
    }
    const { metrics } = measurement;
    if (!this.visible || !metrics || metrics.height <= 0 || measurement.width <= 0) return;
    this.metrics = metrics;
    this.contentOffset = measurement.contentOffset;
    this.clientHeight = measurement.clientHeight;
    const layout = minimapLayout(metrics);
    this.layout = layout;

    this.dom.classList.toggle('cm-minimap-overlap', measurement.overlap);
    const scrolls = metrics.maxScrollTop > 0;
    this.slider.style.display = scrolls ? '' : 'none';
    if (scrolls) {
      this.slider.style.height = `${layout.sliderHeight}px`;
      this.slider.style.transform = `translateY(${layout.sliderTop}px)`;
    }
    this.paint(measurement, metrics, layout);
  }

  private paint(measurement: Measurement, metrics: MinimapMetrics, layout: MinimapLayout) {
    const { dpr } = measurement;
    const width = Math.round(measurement.width * dpr);
    const height = Math.round(metrics.height * dpr);
    const { rowPx, blockPx } = rowMetrics(dpr);
    const offsetPx = Math.round(layout.offset * dpr);
    const signature = `${width}x${height} ${dpr} ${offsetPx} ${layout.firstLine}-${layout.lastLine} ${this.version}`;
    if (signature === this.drawn) return;

    if (this.context === undefined) this.context = this.canvas.getContext('2d');
    const ctx = this.context;
    if (!ctx) return;
    if (!this.image || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.image = ctx.createImageData(width, height);
      this.pixels = new Uint32Array(this.image.data.buffer);
    }
    const pixels = this.pixels;
    if (!pixels) return;
    pixels.fill(0);

    const { state } = this.view;
    const left = PAD_LEFT * dpr;
    for (let line = layout.firstLine; line <= layout.lastLine; line++) {
      const y = line * rowPx - offsetPx;
      const top = Math.max(0, y);
      const bottom = Math.min(height, y + blockPx);
      if (top >= bottom) continue;
      const runs = this.runsFor(state, line);
      for (let i = 0; i + 2 < runs.length; i += 3) {
        const x0 = Math.round(left + (runs[i] ?? 0) * dpr);
        const x1 = Math.min(width, Math.max(x0 + 1, Math.round(left + (runs[i + 1] ?? 0) * dpr)));
        const color = this.color(runs[i + 2] ?? 0);
        for (let row = top; row < bottom; row++)
          pixels.fill(color, row * width + x0, row * width + x1);
      }
    }
    ctx.putImageData(this.image, 0, 0);
    this.drawn = signature;
  }

  /** Render data for a 0-based line, from the cache when its text and context are unchanged. */
  private runsFor(state: EditorState, index: number): readonly number[] {
    if (index >= state.doc.lines) return NO_RUNS;
    const known = this.lineKeys.get(index);
    const cached = known === undefined ? undefined : this.runsCache.get(known);
    if (cached) return cached;

    const line = state.doc.line(index + 1);
    // Tabs only widen text, so this many characters always fill the minimap.
    const end = Math.min(line.to, line.from + MAX_COLUMNS);
    const text = state.doc.sliceString(line.from, end);
    const tree = this.tree;
    // Lines the parser hasn't reached yet are drawn plain and not cached.
    let key = known;
    if (key === undefined && tree.length >= end) {
      key = `${contextKey(tree, line.from)}\u0001${text}`;
      this.lineKeys.set(index, key);
      const hit = this.runsCache.get(key);
      if (hit) return hit;
    }

    const spans: number[] = [];
    if (text && line.from < tree.length) {
      highlightTree(
        tree,
        this.highlighter,
        (from, to, classes) => spans.push(from - line.from, to - line.from, this.styleId(classes)),
        line.from,
        end,
      );
    }
    const runs = buildLineRuns(text, spans, state.tabSize, MAX_COLUMNS);
    if (key !== undefined) this.remember(key, runs);
    return runs;
  }

  private remember(key: string, runs: number[]) {
    if (this.runsCache.size >= CACHE_LIMIT) {
      // Maps iterate in insertion order: drop the oldest quarter.
      let drop = CACHE_LIMIT >> 2;
      for (const old of this.runsCache.keys()) {
        this.runsCache.delete(old);
        if (--drop === 0) break;
      }
    }
    this.runsCache.set(key, runs);
  }

  private styleId(classes: string): number {
    let id = this.styleIds.get(classes);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(classes);
      this.styleIds.set(classes, id);
    }
    return id;
  }

  private color(id: number): number {
    let color = this.colors[id];
    if (color === undefined) {
      const plain = (this.plainColor ??= this.resolve(''));
      const rgba = id === 0 ? plain : this.resolve(this.styles[id] ?? '');
      const isPlain = rgba.every((channel, i) => channel === plain[i]);
      color = pack(rgba, isPlain ? PLAIN_ALPHA : SYNTAX_ALPHA);
      this.colors[id] = color;
    }
    return color;
  }

  /** The text colour the editor's highlight classes give, e.g. `var(--syn-keyword)` resolved. */
  private resolve(classes: string): Rgba {
    this.probe.className = classes ? `cm-minimap-probe ${classes}` : 'cm-minimap-probe';
    return parseCssColor(getComputedStyle(this.probe).color) ?? FALLBACK_COLOR;
  }

  /** The scrollTop that puts a fractional, 0-based line at the top of the viewport. */
  private scrollTopForLine(line: number): number {
    const { doc } = this.view.state;
    const index = clamp(Math.floor(line), 0, doc.lines - 1);
    const block = this.view.lineBlockAt(doc.line(index + 1).from);
    const first = doc.lineAt(block.from).number - 1;
    const span = doc.lineAt(block.to).number - first;
    const fraction = clamp((line - first) / span, 0, 1);
    return this.contentOffset + block.top + fraction * block.height;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    const { metrics, layout } = this;
    if (event.button !== 0 || !metrics || !layout || metrics.maxScrollTop <= 0) return;
    const top = this.dom.getBoundingClientRect().top;
    const y = event.clientY - top;
    const grab = y - layout.sliderTop;
    if (grab < 0 || grab > layout.sliderHeight) {
      // A click beside the slider centres the line under the pointer. (No drag from there: the
      // minimap scrolls along with the jump, so the slider ends up elsewhere.)
      const target = this.scrollTopForLine(minimapLineAt(metrics, layout, y));
      this.view.scrollDOM.scrollTop = target - this.clientHeight / 2;
      return;
    }
    this.drag = { pointerId: event.pointerId, grab, top };
    this.dom.classList.add('cm-minimap-dragging');
    this.dom.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const { drag, metrics, layout } = this;
    if (!drag || event.pointerId !== drag.pointerId || !metrics || !layout) return;
    const target = minimapScrollTarget(metrics, layout, event.clientY - drag.top - drag.grab);
    this.view.scrollDOM.scrollTop =
      'ratio' in target ? target.ratio * metrics.maxScrollTop : this.scrollTopForLine(target.line);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.dom.classList.remove('cm-minimap-dragging');
    if (this.dom.hasPointerCapture(event.pointerId))
      this.dom.releasePointerCapture(event.pointerId);
  };
}

/** The minimap's CSS. Included by `minimap()`; exported for reference and overrides. */
export const minimapTheme = EditorView.theme({
  '.cm-minimap': {
    position: 'sticky',
    top: '0',
    right: '0',
    flex: 'none',
    alignSelf: 'flex-start',
    width: `${WIDTH}px`,
    height: '100%',
    boxSizing: 'border-box',
    overflow: 'hidden',
    // Above the content, selection and cursor layers; below panels and tooltips.
    zIndex: '200',
    backgroundColor: 'var(--bg)',
    color: 'var(--code-fg)',
    cursor: 'default',
    userSelect: 'none',
    touchAction: 'none',
  },
  '.cm-minimap-hidden': { display: 'none' },
  '.cm-minimap-overlap': { boxShadow: '-1px 0 0 var(--line)' },
  '.cm-minimap canvas': {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  },
  // Drawn behind the blocks, so it reads as a translucent band without dimming them.
  '.cm-minimap-slider': {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    backgroundColor: 'var(--hover)',
    pointerEvents: 'none',
    willChange: 'transform',
    transition: 'background-color var(--dur) var(--ease)',
  },
  '.cm-minimap:hover .cm-minimap-slider, .cm-minimap-dragging .cm-minimap-slider': {
    backgroundColor: 'var(--active)',
  },
  '.cm-minimap-probe': {
    position: 'absolute',
    width: '0',
    height: '0',
    overflow: 'hidden',
    visibility: 'hidden',
  },
});

const minimapPlugin = ViewPlugin.fromClass(MinimapView, {
  // Keeps the cursor out from under the minimap when scrolling it into view.
  provide: (plugin) =>
    EditorView.scrollMargins.of((view) => (view.plugin(plugin)?.visible ? { right: WIDTH } : null)),
});

const minimapExtension: Extension = [minimapPlugin, minimapTheme];

/** A minimap at the editor's right edge. Put it in a Compartment to switch it on and off. */
export function minimap(): Extension {
  return minimapExtension;
}
