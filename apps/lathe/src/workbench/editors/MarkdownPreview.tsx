// A live preview of a Markdown file. Each block carries the source line it starts on, so the
// preview follows the editor as you scroll it, and the editor follows the preview. Links to
// other files open them, #links go to headings, and images beside the file are shown.

import { EditorView } from '@codemirror/view';
import { FileCode } from 'lucide-react';
import { marked, type Token, type TokensList } from 'marked';
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type TextDoc,
  documentForPath,
  getDocument,
  onDocumentsChanged,
  openDocument,
} from '../../editor/documents';
import { backend } from '../../lib/backend';
import { dirname, extname, resolve } from '../../lib/paths';
import { isLocal, sanitizeHTML } from '../../lsp/sanitize';
import { type Tab, openDoc, openPath, useEditors } from './store';

const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;

/** The Markdown as HTML, one <div data-line> per top-level block (lines counted from 0). */
export function renderPreview(text: string): string {
  const source = text.replace(/\r\n?/g, '\n');
  // YAML front matter is data about the page, not part of it.
  const front = FRONT_MATTER.exec(source)?.[0] ?? '';
  const tokens = marked.lexer(source.slice(front.length), { gfm: true });
  const body = source.slice(front.length);
  let at = 0;
  let html = '';
  for (const token of tokens) {
    // Blocks come in order; find each one's text to learn its line (link definitions leave no
    // token, so counting lines token by token would drift).
    const found = token.raw ? body.indexOf(token.raw, at) : -1;
    const start = found >= 0 ? found : at;
    at = start + token.raw.length;
    if (token.type === 'space') continue;
    const line = countLines(front) + countLines(body.slice(0, start));
    const block = Object.assign([token], { links: tokens.links }) as Token[] as TokensList;
    const inner = marked
      .parser(block, { gfm: true })
      .replace(/<input (checked="" )?disabled="" type="checkbox">/g, (_m, checked?: string) =>
        checked ? '☑' : '☐',
      );
    html += `<div data-line="${line}">${sanitizeHTML(inner, { images: 'local', localLinks: true })}</div>`;
  }
  return html;
}

const countLines = (text: string) => text.split('\n').length - 1;

/** "Some Heading!" → "some-heading", as GitHub makes heading anchors. */
function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** The document a preview tab shows: by id, then by path (it may have been closed and reopened). */
function usePreviewedDoc(tab: Tab): { doc: TextDoc | null; failed: boolean } {
  const find = () =>
    getDocument(tab.source ?? '') ?? (tab.path ? documentForPath(tab.path) : undefined) ?? null;
  const [doc, setDoc] = useState<TextDoc | null>(find);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const update = () => {
      const found = find();
      if (found) {
        setDoc(found);
        return;
      }
      if (!tab.path) {
        setDoc(null);
        return;
      }
      openDocument(tab.path).then(
        (opened) => {
          setFailed(false);
          setDoc(opened);
        },
        () => setFailed(true),
      );
    };
    update();
    return onDocumentsChanged(update);
    // `find` reads only the tab's source and path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.source, tab.path]);
  return { doc, failed };
}

/** The editor line (0-based, with a fraction) at the top of an editor. */
function editorTopLine(view: EditorView): number {
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  const line = view.state.doc.lineAt(block.from).number - 1;
  return line + Math.max(0, Math.min(1, (height - block.top) / Math.max(1, block.height)));
}

/** Scrolls an editor so `line` (0-based, with a fraction) is at its top. */
function scrollEditorTo(view: EditorView, line: number) {
  const { doc } = view.state;
  const whole = Math.max(0, Math.min(Math.floor(line), doc.lines - 1));
  const block = view.lineBlockAt(doc.line(whole + 1).from);
  const scroller = view.scrollDOM;
  const offset = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = offset + block.top + (line - whole) * block.height;
}

interface Block {
  line: number;
  top: number;
}

function blocksOf(content: HTMLElement): Block[] {
  return [...content.querySelectorAll<HTMLElement>(':scope > [data-line]')].map((el) => ({
    line: Number(el.dataset.line),
    top: el.offsetTop,
  }));
}

export function MarkdownPreview({ tab }: { tab: Tab }) {
  const { doc, failed } = usePreviewedDoc(tab);
  const [html, setHtml] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Who is scrolling the other: the editor or the preview (null when neither). */
  const leader = useRef<'editor' | 'preview' | null>(null);
  const leaderTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const images = useRef(new Map<string, string>());

  const lead = (who: 'editor' | 'preview') => {
    leader.current = who;
    clearTimeout(leaderTimer.current);
    leaderTimer.current = setTimeout(() => (leader.current = null), 150);
  };

  // Render now, and again shortly after each edit.
  useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => setHtml(renderPreview(doc.text.toString()));
    render();
    const onText = () => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    };
    doc.textListeners.add(onText);
    return () => {
      doc.textListeners.delete(onText);
      clearTimeout(timer);
    };
  }, [doc]);

  const scrollPreviewTo = (line: number) => {
    const box = scroller.current;
    const inner = content.current;
    if (!box || !inner || !doc) return;
    const blocks = blocksOf(inner);
    const first = blocks[0];
    if (!first || line <= first.line) {
      box.scrollTop = 0;
      return;
    }
    let index = blocks.findIndex((b) => b.line > line) - 1;
    if (index < 0) index = blocks.length - 1;
    const before = blocks[index]!;
    const after = blocks[index + 1];
    const endLine = after?.line ?? doc.text.lines;
    const endTop = after?.top ?? inner.offsetHeight;
    const fraction = Math.min(1, (line - before.line) / Math.max(1, endLine - before.line));
    box.scrollTop = inner.offsetTop + before.top + (endTop - before.top) * fraction;
  };

  const editorOf = (d: TextDoc) => [...d.views].find((v) => v.dom.isConnected) ?? null;

  // A new preview starts where the editor is.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const inner = content.current;
    if (inner) inner.innerHTML = html;
    if (!doc || placed.current || !html) return;
    placed.current = true;
    const view = editorOf(doc);
    if (view) scrollPreviewTo(editorTopLine(view));
    // Only the first render places it; later ones keep where you are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, doc]);

  // Images beside the file (relative paths), loaded from disk as blobs.
  useEffect(() => {
    const inner = content.current;
    if (!inner || !doc?.path) return;
    const base = dirname(doc.path);
    let cancelled = false;
    for (const img of inner.querySelectorAll<HTMLImageElement>('img[data-local-src]')) {
      const src = img.dataset.localSrc ?? '';
      if (!isLocal(src)) continue;
      let path: string;
      try {
        path = resolve(base, decodeURI(src.split(/[?#]/)[0]!));
      } catch {
        continue;
      }
      const cached = images.current.get(path);
      if (cached) {
        img.src = cached;
        continue;
      }
      const type = IMAGE_TYPES[extname(path).toLowerCase()];
      if (!type) continue;
      backend()
        .fs.readBytes(path)
        .then((bytes) => {
          if (cancelled) return;
          const url = URL.createObjectURL(new Blob([bytes], { type }));
          images.current.set(path, url);
          img.src = url;
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [html, doc]);

  useEffect(() => {
    const urls = images.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // The editor scrolls → the preview follows.
  useEffect(() => {
    if (!doc) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains('cm-scroller')) return;
      const view = EditorView.findFromDOM(target);
      if (!view || !doc.views.has(view) || leader.current === 'preview') return;
      lead('editor');
      scrollPreviewTo(editorTopLine(view));
    };
    document.addEventListener('scroll', onScroll, { capture: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // The preview scrolls → the editor follows.
  const onPreviewScroll = () => {
    const box = scroller.current;
    const inner = content.current;
    if (!box || !inner || !doc || leader.current === 'editor') return;
    const view = editorOf(doc);
    if (!view) return;
    lead('preview');
    const y = box.scrollTop - inner.offsetTop;
    const blocks = blocksOf(inner);
    if (!blocks.length || y <= 0) {
      scrollEditorTo(view, 0);
      return;
    }
    let index = blocks.findIndex((b) => b.top > y) - 1;
    if (index < 0) index = blocks[0]!.top > y ? 0 : blocks.length - 1;
    const before = blocks[index]!;
    const after = blocks[index + 1];
    const endTop = after?.top ?? inner.offsetHeight;
    const endLine = after?.line ?? doc.text.lines;
    const fraction = Math.max(0, Math.min(1, (y - before.top) / Math.max(1, endTop - before.top)));
    scrollEditorTo(view, before.line + (endLine - before.line) * fraction);
  };

  /** Shows the source: in a group that already has it, or the active one. */
  const showSource = (line?: number) => {
    if (!doc) return;
    const group = useEditors
      .getState()
      .groups.find((g) => g.tabs.some((t) => t.kind === 'text' && t.docId === doc.id));
    openDoc(doc, { group: group?.id, selection: line ? { line } : undefined });
  };

  const onClick = (event: ReactMouseEvent) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      void backend().openLink(href);
      return;
    }
    if (href.startsWith('#')) {
      const wanted = slug(decodeURIComponent(href.slice(1)));
      const heading = [
        ...(content.current?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? []),
      ].find((h) => slug(h.textContent ?? '') === wanted);
      heading?.scrollIntoView({ block: 'start' });
      return;
    }
    if (!doc?.path || !isLocal(href)) return;
    const [file = '', fragment = ''] = href.split('#');
    let target: string;
    try {
      target = resolve(dirname(doc.path), decodeURI(file));
    } catch {
      return;
    }
    const line = /^L(\d+)/.exec(fragment)?.[1];
    void openPath(target, { selection: line ? { line: Number(line) } : undefined });
  };

  const name = doc?.name ?? tab.path ?? 'Markdown';
  return (
    <div className="relative h-full min-h-0" data-editor="preview">
      <div
        ref={scroller}
        tabIndex={0}
        role="document"
        aria-label={`Preview of ${name}`}
        className="h-full overflow-y-auto outline-none"
        onScroll={onPreviewScroll}
        onClick={onClick}
        onDoubleClick={(event) => {
          const block = (event.target as HTMLElement).closest<HTMLElement>('[data-line]');
          if (block) showSource(Number(block.dataset.line) + 1);
        }}
      >
        {failed ? (
          <p className="p-8 text-[12.5px] text-text-3">The file couldn&apos;t be opened.</p>
        ) : doc && !doc.text.length ? (
          <p className="p-8 text-[12.5px] text-text-3">Nothing to preview yet.</p>
        ) : null}
        <div ref={content} className="nb-markdown md-preview relative" />
      </div>
      <button
        type="button"
        aria-label={`Show the source of ${name}`}
        title="Show the source (double-click a paragraph to go to it)"
        className="absolute top-2 right-4 grid size-7 place-items-center rounded-md border border-line bg-raised text-text-3 hover:text-text"
        onClick={() => showSource()}
      >
        <FileCode className="size-3.5" />
      </button>
    </div>
  );
}
