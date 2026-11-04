import { MergeView, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { ArrowDown, ArrowUp, Columns2, FileText, Rows2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { setActiveEditor, updateStatus } from '../../editor/active';
import { type TextDoc, documentForPath, openDocument } from '../../editor/documents';
import { detectLanguage } from '../../editor/languages';
import { editorExtensions, ensureLanguage } from '../../editor/setup';
import { latheTheme } from '../../editor/theme';
import { backend, errorMessage } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { baseOf, useGit } from '../../services/git';
import { type DiffSpec, keepTab, openPath } from './store';

/** The older side's text ("" when the file didn't exist there). */
async function leftText(spec: DiffSpec): Promise<string> {
  if ('history' in spec.left) return backend().history.read(spec.path, spec.left.history);
  return gitText(spec.left.git, spec.path);
}

async function gitText(rev: string, path: string): Promise<string> {
  if (rev === 'index' || rev === 'HEAD') return (await baseOf(path, rev))?.text ?? '';
  const root = useGit.getState().repo?.root;
  if (!root) return '';
  return (
    (
      await backend()
        .git.show(root, rev, path)
        .catch(() => null)
    )?.text ?? ''
  );
}

async function languageFor(path: string): Promise<Extension> {
  const description = detectLanguage(path);
  return description ? ((await description.load().catch(() => null)) ?? []) : [];
}

const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

/** Mono's diff colours: removed text tinted with the danger colour, added with the accent. */
const tint = (color: string, amount: number) =>
  `color-mix(in srgb, ${color} ${amount}%, transparent)`;
const diffTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: tint('var(--danger)', 9) },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: tint('var(--accent-fg)', 9),
  },
  // 20% keeps the removed text readable on it (4.5:1 in both themes).
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background: tint('var(--danger)', 20),
    textDecoration: 'none',
  },
  '&.cm-merge-b .cm-changedText, .cm-inlineChangedLine .cm-changedText': {
    background: tint('var(--accent-fg)', 30),
  },
  '.cm-changeGutter': { width: '3px', paddingLeft: '1px' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: 'var(--danger)' },
  '&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter': { background: 'var(--accent-fg)' },
  '.cm-collapsedLines': {
    color: 'var(--text-3)',
    background: 'var(--bg-raised)',
    borderBlock: '1px solid var(--line)',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
  },
});

/** Two versions of a file, side by side or inline. A working file side is live and editable. */
export function DiffEditor({
  spec,
  groupId,
  tabId,
}: {
  spec: DiffSpec;
  groupId: string;
  tabId: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'split' | 'inline'>('split');
  const [error, setError] = useState<string | null>(null);
  const navigable = useRef<EditorView | null>(null);
  // The index and HEAD move with Git operations: the older side reloads then.
  const revision = useGit((s) => s.revision);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    setError(null);
    void (async () => {
      try {
        const [left, language] = await Promise.all([leftText(spec), languageFor(spec.path)]);
        let doc: TextDoc | null = null;
        let right = '';
        if (spec.right === 'working')
          doc = documentForPath(spec.path) ?? (await openDocument(spec.path));
        else right = await gitText(spec.right.git, spec.path);
        if (disposed) return;
        // Screen readers hear which side is which.
        const named = (side: string) =>
          EditorView.contentAttributes.of({ 'aria-label': `${spec.title}: ${side} (read-only)` });
        const fixed = [readOnly, language, latheTheme, lineNumbers(), diffTheme];
        const live = doc
          ? editorExtensions(
              doc,
              {
                onEdit: () => keepTab(groupId, tabId),
                onSelection: (view) => updateStatus(view, doc),
                onFocus: (view) => setActiveEditor(view, doc),
              },
              { diff: true },
            ).concat(diffTheme)
          : [fixed, named('after')];
        el.replaceChildren();
        if (mode === 'split') {
          const merge = new MergeView({
            a: { doc: left, extensions: [fixed, named('before')] },
            b: { doc: doc ? doc.text : right, extensions: live },
            parent: el,
            gutter: true,
            highlightChanges: true,
            collapseUnchanged: { margin: 3, minSize: 8 },
          });
          if (doc) {
            doc.views.add(merge.b);
            ensureLanguage(merge.b, doc);
          }
          navigable.current = merge.b;
          cleanup = () => {
            doc?.views.delete(merge.b);
            merge.destroy();
          };
        } else {
          const view = new EditorView({
            parent: el,
            state: EditorState.create({
              doc: doc ? doc.text : right,
              extensions: [
                live,
                unifiedMergeView({ original: left, mergeControls: false, gutter: true }),
              ],
            }),
          });
          if (doc) {
            doc.views.add(view);
            ensureLanguage(view, doc);
          }
          navigable.current = view;
          cleanup = () => {
            doc?.views.delete(view);
            view.destroy();
          };
        }
      } catch (err) {
        if (!disposed) setError(errorMessage(err));
      }
    })();
    return () => {
      disposed = true;
      navigable.current = null;
      cleanup();
    };
  }, [spec, mode, groupId, tabId, revision]);

  const go = (next: boolean) => {
    const view = navigable.current;
    if (!view) return;
    (next ? goToNextChunk : goToPreviousChunk)(view);
    view.focus();
  };

  const button =
    'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';
  return (
    <div className="flex h-full min-h-0 flex-col" data-diff-editor>
      <div className="flex h-7 shrink-0 items-center gap-0.5 border-b border-line px-2 text-[11.5px] text-text-3">
        <span className="min-w-0 flex-1 truncate">{spec.title}</span>
        <button
          type="button"
          className={button}
          aria-label="Previous change"
          title="Previous change"
          onClick={() => go(false)}
        >
          <ArrowUp />
        </button>
        <button
          type="button"
          className={button}
          aria-label="Next change"
          title="Next change"
          onClick={() => go(true)}
        >
          <ArrowDown />
        </button>
        <button
          type="button"
          className={cn(button, mode === 'inline' && 'text-text')}
          aria-label={mode === 'split' ? 'Show inline' : 'Show side by side'}
          title={mode === 'split' ? 'Show inline' : 'Show side by side'}
          onClick={() => setMode(mode === 'split' ? 'inline' : 'split')}
        >
          {mode === 'split' ? <Rows2 /> : <Columns2 />}
        </button>
        <button
          type="button"
          className={button}
          aria-label="Open the file"
          title="Open the file"
          onClick={() => void openPath(spec.path)}
        >
          <FileText />
        </button>
      </div>
      {error ? (
        <p className="p-4 text-[12px] text-danger">{error}</p>
      ) : (
        <div ref={host} className="diff-host min-h-0 flex-1 overflow-hidden" />
      )}
    </div>
  );
}
