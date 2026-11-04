// The debugger in the editor: breakpoint dots in their own gutter (click it, or F9; right-click
// for a condition, a hit count or a log message), breakpoints that follow their lines as you
// edit, the line where the program is paused, and hovering a name to see its value.

import { type Extension, RangeSet, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type ViewUpdate,
  gutter,
  hoverTooltip,
} from '@codemirror/view';
import { getActiveView } from '../editor/active';
import { type TextDoc, syncAnnotation } from '../editor/documents';
import { setDebugExtensionProvider } from '../editor/setup';
import { pathKey } from '../lib/paths';
import { notify } from '../services/notifications';
import { type MenuEntry, showMenuAt } from '../ui/Menu';
import { activeTab } from '../workbench/editors/store';
import { quickInputText } from '../workbench/quickinput/store';
import { type Evaluated, type Variable, evaluate, variablesOf } from './manager';
import {
  type Breakpoint,
  breakpointAt,
  debugStateOf,
  moveBreakpoints,
  removeBreakpoint,
  setBreakpoint,
  toggleBreakpoint,
  updateBreakpoint,
  useDebug,
} from './store';

type Kind = 'normal' | 'conditional' | 'log' | 'disabled' | 'unverified';

export function breakpointKind(b: Breakpoint, active: boolean): Kind {
  if (!b.enabled || !active) return 'disabled';
  if (b.verified === false) return 'unverified';
  if (b.logMessage) return 'log';
  if (b.condition || b.hitCondition) return 'conditional';
  return 'normal';
}

export function describeBreakpoint(b: Breakpoint, active = true): string {
  const parts = [b.logMessage ? `Logpoint: ${b.logMessage}` : `Breakpoint on line ${b.line}`];
  if (b.condition) parts.push(`when ${b.condition}`);
  if (b.hitCondition) parts.push(`hit count ${b.hitCondition}`);
  if (!b.enabled) parts.push('(disabled)');
  else if (!active) parts.push('(breakpoints are off)');
  if (b.verified === false) parts.push(`— not set${b.message ? `: ${b.message}` : ''}`);
  return parts.join(' ');
}

class BreakpointMarker extends GutterMarker {
  constructor(
    readonly bp: Breakpoint,
    readonly kind: Kind,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof BreakpointMarker &&
      other.bp.id === this.bp.id &&
      other.kind === this.kind &&
      other.bp.message === this.bp.message &&
      other.bp.condition === this.bp.condition &&
      other.bp.hitCondition === this.bp.hitCondition &&
      other.bp.logMessage === this.bp.logMessage
    );
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = `cm-breakpoint cm-breakpoint-${this.kind}`;
    el.title = describeBreakpoint(this.bp, this.kind !== 'disabled' || this.bp.enabled);
    return el;
  }
}

class ArrowMarker extends GutterMarker {
  constructor(readonly top: boolean) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ArrowMarker && other.top === this.top;
  }
  override toDOM(): Node {
    const el = document.createElement('div');
    el.className = this.top ? 'cm-debugArrow' : 'cm-debugArrow cm-debugArrow-frame';
    el.title = this.top ? 'Paused here' : 'The frame you selected';
    return el;
  }
}

const setBreakpointMarkers = StateEffect.define<RangeSet<GutterMarker>>();

const breakpointField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    for (const effect of tr.effects) if (effect.is(setBreakpointMarkers)) return effect.value;
    return tr.docChanged ? set.map(tr.changes) : set;
  },
});

interface Location {
  /** The line the program is paused on (1-based), if it's in this file. */
  top: number | null;
  /** The line of the frame you picked in the call stack, when that isn't the top one. */
  frame: number | null;
}

const setLocation = StateEffect.define<Location>();

const stoppedLine = Decoration.line({ class: 'cm-debugStopped' });
const frameLine = Decoration.line({ class: 'cm-debugFrame' });

const locationField = StateField.define<{ lines: DecorationSet; arrows: RangeSet<GutterMarker> }>({
  create: () => ({ lines: Decoration.none, arrows: RangeSet.empty }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setLocation)) continue;
      const { doc } = tr.state;
      const lines = [];
      const arrows = [];
      for (const [line, top] of [
        [effect.value.top, true],
        [effect.value.frame, false],
      ] as const) {
        if (line === null || line < 1 || line > doc.lines) continue;
        const from = doc.line(line).from;
        lines.push((top ? stoppedLine : frameLine).range(from));
        arrows.push(new ArrowMarker(top).range(from));
      }
      const order = <T extends { from: number }>(list: T[]) => list.sort((a, b) => a.from - b.from);
      return {
        lines: Decoration.set(order(lines)),
        arrows: RangeSet.of(order(arrows)),
      };
    }
    if (!tr.docChanged) return value;
    return { lines: value.lines.map(tr.changes), arrows: value.arrows.map(tr.changes) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.lines),
});

function locationIn(key: string): Location {
  const { sessions, focus } = useDebug.getState();
  const session = sessions.find((s) => s.id === focus?.sessionId);
  const thread = session?.threads.find((t) => t.id === focus?.threadId);
  if (!thread?.stopped || !thread.frames.length) return { top: null, frame: null };
  // The top frame with a file is where it's paused (runtime frames have none).
  const top = thread.frames.slice(0, 8).find((f) => f.path) ?? null;
  const picked = thread.frames.find((f) => f.id === focus?.frameId) ?? null;
  const here = (f: typeof top) => (f?.path && pathKey(f.path) === key ? f.line : null);
  return { top: here(top), frame: picked && picked !== top ? here(picked) : null };
}

function markersFor(view: EditorView, list: Breakpoint[], active: boolean) {
  const { doc } = view.state;
  return RangeSet.of(
    list
      .filter((b) => b.line >= 1 && b.line <= doc.lines)
      .sort((a, b) => a.line - b.line)
      .map((b) => new BreakpointMarker(b, breakpointKind(b, active)).range(doc.line(b.line).from)),
  );
}

/** Keeps one editor's breakpoints and paused line in step with the debugger. */
function debugSync(path: string) {
  const key = pathKey(path);
  return ViewPlugin.fromClass(
    class {
      private breakpoints = '';
      private location = '';
      private scheduled = false;
      private destroyed = false;
      private readonly stop: () => void;

      constructor(readonly view: EditorView) {
        this.stop = useDebug.subscribe(() => this.schedule());
        this.schedule();
      }

      /** Store changes can come from inside an editor update; dispatch after it. */
      schedule() {
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
          this.scheduled = false;
          if (!this.destroyed) this.sync();
        });
      }

      sync() {
        const { breakpoints, breakpointsActive } = useDebug.getState();
        const mine = breakpoints.filter((b) => pathKey(b.path) === key);
        const signature = mine
          .map(
            (b) =>
              `${b.id}:${b.line}:${breakpointKind(b, breakpointsActive)}:${b.message ?? ''}:${b.condition ?? ''}:${b.hitCondition ?? ''}:${b.logMessage ?? ''}`,
          )
          .join('|');
        const location = locationIn(key);
        const where = `${location.top}:${location.frame}`;
        const effects: StateEffect<unknown>[] = [];
        if (signature !== this.breakpoints) {
          this.breakpoints = signature;
          effects.push(setBreakpointMarkers.of(markersFor(this.view, mine, breakpointsActive)));
        }
        if (where !== this.location) {
          this.location = where;
          effects.push(setLocation.of(location));
        }
        if (effects.length) this.view.dispatch({ effects });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        // Another editor of this document made the edit and moves the breakpoints itself.
        if (update.transactions.some((tr) => tr.annotation(syncAnnotation))) return;
        const moves = new Map<string, number>();
        const { doc } = update.state;
        update.state.field(breakpointField).between(0, doc.length, (from, _to, marker) => {
          if (!(marker instanceof BreakpointMarker)) return;
          const line = doc.lineAt(from).number;
          if (line !== marker.bp.line) moves.set(marker.bp.id, line);
        });
        if (moves.size) queueMicrotask(() => moveBreakpoints(moves));
      }

      destroy() {
        this.destroyed = true;
        this.stop();
      }
    },
  );
}

const spacer = new (class extends GutterMarker {
  override toDOM(): Node {
    return document.createElement('div');
  }
})();

function lineAt(view: EditorView, from: number): number {
  return view.state.doc.lineAt(from).number;
}

function breakpointGutter(path: string): Extension {
  return gutter({
    class: 'cm-breakpointGutter',
    renderEmptyElements: true,
    markers: (view) => [view.state.field(breakpointField), view.state.field(locationField).arrows],
    initialSpacer: () => spacer,
    domEventHandlers: {
      mousedown: (view, line, event) => {
        if ((event as MouseEvent).button !== 0) return false;
        toggleBreakpoint(path, lineAt(view, line.from));
        return true;
      },
      contextmenu: (view, line, event) => {
        const mouse = event as MouseEvent;
        mouse.preventDefault();
        showMenuAt(mouse.clientX, mouse.clientY, breakpointMenu(path, lineAt(view, line.from)));
        return true;
      },
    },
  });
}

export function breakpointMenu(path: string, line: number): MenuEntry[] {
  const bp = breakpointAt(path, line);
  if (!bp) {
    return [
      { label: 'Add breakpoint', shortcut: 'F9', run: () => void setBreakpoint(path, line) },
      {
        label: 'Add conditional breakpoint…',
        run: () => void editBreakpoint(path, line, 'condition'),
      },
      { label: 'Add logpoint…', run: () => void editBreakpoint(path, line, 'logMessage') },
    ];
  }
  return [
    { label: 'Remove breakpoint', shortcut: 'F9', run: () => removeBreakpoint(bp.id) },
    {
      label: bp.enabled ? 'Disable breakpoint' : 'Enable breakpoint',
      run: () => updateBreakpoint(bp.id, { enabled: !bp.enabled }),
    },
    'separator',
    { label: 'Edit condition…', run: () => void editBreakpoint(path, line, 'condition') },
    { label: 'Edit hit count…', run: () => void editBreakpoint(path, line, 'hitCondition') },
    { label: 'Edit log message…', run: () => void editBreakpoint(path, line, 'logMessage') },
  ];
}

const PROMPTS = {
  condition: {
    placeholder: 'An expression, like x > 5',
    prompt: 'Stop only when this expression is true. Press Enter to save.',
  },
  hitCondition: {
    placeholder: 'A hit count, like 3 or >= 10',
    prompt: 'Stop only when the hit count matches. Press Enter to save.',
  },
  logMessage: {
    placeholder: 'A message, like x is {x}',
    prompt:
      'Print this instead of stopping; {expressions} in braces are filled in. Press Enter to save.',
  },
};

/** Asks for a breakpoint's condition, hit count or log message (adding the breakpoint). */
export async function editBreakpoint(
  path: string,
  line: number,
  field: 'condition' | 'hitCondition' | 'logMessage',
) {
  const bp = breakpointAt(path, line);
  const value = await quickInputText({ ...PROMPTS[field], value: bp?.[field] ?? '' });
  if (value === null) return;
  if (bp) updateBreakpoint(bp.id, { [field]: value, enabled: true });
  else setBreakpoint(path, line, { [field]: value });
}

/** The active editor's file and cursor line, for F9 and its relatives. */
function cursorLine(): { path: string; line: number } | null {
  const view = getActiveView();
  const { doc } = activeTab();
  if (!view || !doc) return null;
  if (!doc.path) {
    notify('info', 'Save the file first, then add breakpoints to it.');
    return null;
  }
  return { path: doc.path, line: view.state.doc.lineAt(view.state.selection.main.head).number };
}

export function toggleBreakpointAtCursor() {
  const at = cursorLine();
  if (at) toggleBreakpoint(at.path, at.line);
}

export function editBreakpointAtCursor(field: 'condition' | 'hitCondition' | 'logMessage') {
  const at = cursorLine();
  if (at) void editBreakpoint(at.path, at.line, field);
}

/** The expression under the mouse: a name and the members before it ("self.items" on items). */
function expressionAt(
  view: EditorView,
  pos: number,
): { from: number; to: number; text: string } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const at = pos - line.from;
  const word = (c: string | undefined) => !!c && /[\w$]/.test(c);
  if (!word(text[at]) && !word(text[at - 1])) return null;
  let start = at;
  let end = at;
  while (start > 0 && word(text[start - 1])) start--;
  while (end < text.length && word(text[end])) end++;
  if (start === end || /^\d/.test(text.slice(start, end))) return null;
  for (;;) {
    const dot = text[start - 1] === '.' ? 1 : text.slice(start - 2, start) === '->' ? 2 : 0;
    if (!dot) break;
    let before = start - dot;
    while (before > 0 && word(text[before - 1])) before--;
    if (before === start - dot) break;
    start = before;
  }
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) };
}

function row(
  parent: HTMLElement,
  variable: Pick<Variable, 'name' | 'value' | 'type' | 'variablesReference'>,
  sessionId: string,
  depth: number,
) {
  const line = document.createElement('div');
  line.className = 'cm-debugHover-row';
  line.style.paddingLeft = `${depth * 12}px`;
  const toggle = document.createElement('span');
  toggle.className = 'cm-debugHover-toggle';
  toggle.textContent = variable.variablesReference ? '›' : '';
  const name = document.createElement('span');
  name.className = 'cm-debugHover-name';
  name.textContent = variable.name;
  const value = document.createElement('span');
  value.className = 'cm-debugHover-value';
  value.textContent = variable.value;
  if (variable.type) line.title = variable.type;
  line.append(toggle, name, document.createTextNode(' = '), value);
  parent.append(line);
  if (!variable.variablesReference) return;
  let children: HTMLElement | null = null;
  line.classList.add('cm-debugHover-expandable');
  line.addEventListener('mousedown', (event) => {
    event.preventDefault();
    if (children) {
      children.remove();
      children = null;
      toggle.textContent = '›';
      return;
    }
    const box = document.createElement('div');
    children = box;
    line.after(box);
    toggle.textContent = '⌄';
    void variablesOf(sessionId, variable.variablesReference).then((list) => {
      for (const child of list.slice(0, 300)) row(box, child, sessionId, depth + 1);
    });
  });
}

function hoverDom(expression: string, result: Evaluated): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-debugHover';
  row(
    dom,
    {
      name: expression,
      value: result.result,
      type: result.type,
      variablesReference: result.variablesReference,
    },
    result.sessionId,
    0,
  );
  return dom;
}

const debugHover = hoverTooltip(
  async (view, pos) => {
    if (debugStateOf(useDebug.getState()) !== 'stopped') return null;
    const found = expressionAt(view, pos);
    if (!found) return null;
    let result: Evaluated;
    try {
      result = await evaluate(found.text, 'hover');
    } catch {
      return null;
    }
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: () => ({ dom: hoverDom(found.text, result) }),
    };
  },
  { hoverTime: 300 },
);

const dot = {
  content: '""',
  position: 'absolute',
  left: '4px',
  top: 'calc(50% - 4px)',
  width: '8px',
  height: '8px',
  borderRadius: '50%',
  boxSizing: 'border-box',
};

const debugTheme = EditorView.baseTheme({
  '.cm-breakpointGutter .cm-gutterElement': {
    position: 'relative',
    width: '16px',
    padding: '0 !important',
    cursor: 'default',
  },
  '.cm-breakpointGutter .cm-gutterElement:hover:not(:has(.cm-breakpoint))::before': {
    ...dot,
    background: 'color-mix(in srgb, var(--danger) 40%, transparent)',
  },
  '.cm-breakpoint': { ...dot, background: 'var(--danger)' },
  '.cm-breakpoint-conditional::after': {
    content: '""',
    position: 'absolute',
    left: '2px',
    right: '2px',
    top: '3px',
    height: '2px',
    background: 'var(--bg)',
  },
  '.cm-breakpoint-log': { borderRadius: '1px', transform: 'rotate(45deg) scale(0.9)' },
  '.cm-breakpoint-disabled': {
    background: 'transparent',
    border: '1.5px solid var(--text-4)',
  },
  '.cm-breakpoint-unverified': {
    background: 'transparent',
    border: '1.5px solid var(--text-3)',
  },
  '.cm-debugArrow': {
    position: 'absolute',
    left: '3px',
    top: 'calc(50% - 5px)',
    width: '11px',
    height: '10px',
    background: 'var(--accent-fg)',
    clipPath: 'polygon(0 25%, 55% 25%, 55% 0, 100% 50%, 55% 100%, 55% 75%, 0 75%)',
    zIndex: '1',
  },
  '.cm-debugArrow-frame': { background: 'var(--text-3)' },
  '.cm-debugStopped': { backgroundColor: 'color-mix(in srgb, var(--accent-fg) 15%, transparent)' },
  '.cm-debugFrame': { backgroundColor: 'color-mix(in srgb, var(--text-3) 12%, transparent)' },
  '.cm-debugHover': {
    maxHeight: '320px',
    maxWidth: '560px',
    overflow: 'auto',
    padding: '4px 8px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
  },
  '.cm-debugHover-row': { whiteSpace: 'pre', lineHeight: '1.6' },
  '.cm-debugHover-expandable': { cursor: 'pointer' },
  '.cm-debugHover-toggle': { display: 'inline-block', width: '12px', color: 'var(--text-3)' },
  '.cm-debugHover-name': { color: 'var(--text-2)' },
  '.cm-debugHover-value': { color: 'var(--text)' },
});

function debugExtensions(doc: TextDoc): Extension {
  if (!doc.path) return [];
  return [
    breakpointField,
    locationField,
    breakpointGutter(doc.path),
    debugSync(doc.path),
    debugHover,
    debugTheme,
  ];
}

setDebugExtensionProvider(debugExtensions);
