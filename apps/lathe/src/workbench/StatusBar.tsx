import { Bell, CircleAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useEditorStatus } from '../editor/active';
import { getDocument, useDocumentsVersion } from '../editor/documents';
import { languageNameOf } from '../editor/languages';
import { cn } from '../lib/cn';
import { executeCommand } from '../services/commands';
import { displayKey, onChordChanged } from '../services/keybindings';
import { useToasts } from '../services/notifications';
import { showPanel } from './layout';
import { GitStatus } from './GitStatus';
import { LanguageStatus } from './LanguageStatus';
import { NotebookKernelStatus } from '../notebook/KernelStatus';
import { PluginStatusItems } from '../plugins/StatusItems';
import { useProblemCounts } from './ProblemsView';

/** A status bar button. Its name starts with what it shows (`text`), then says what it does
 * ("UTF-8, change encoding"), so the words you see are the words you'd say to voice control. An
 * item without `text` is named by its children, or by `label` with `iconOnly`. */
function Item({
  children,
  label,
  text,
  hint,
  iconOnly,
  onClick,
  className,
}: {
  children: React.ReactNode;
  /** The tooltip. */
  label: string;
  text?: string;
  hint?: string;
  iconOnly?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={iconOnly ? label : text !== undefined ? `${text}, ${hint ?? label}` : undefined}
      onClick={onClick}
      className={cn(
        'flex h-full items-center gap-1 px-1.5 text-text-3 transition-colors duration-(--dur) hover:bg-hover hover:text-text',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The thin line at the bottom: problems on the left, the active editor's details on the right. */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const problemsLabel = (c: { errors: number; warnings: number }) =>
  `Problems: ${plural(c.errors, 'error')}, ${plural(c.warnings, 'warning')} (Ctrl+Shift+M)`;

export function StatusBar() {
  useDocumentsVersion();
  const status = useEditorStatus();
  const doc = status.docId ? getDocument(status.docId) : undefined;
  const toasts = useToasts((s) => s.toasts.length);
  const counts = useProblemCounts();
  const [chord, setChord] = useState<string | null>(null);
  useEffect(() => onChordChanged(setChord), []);

  const indent = doc?.views.values().next().value?.state;
  const tabSize = indent?.tabSize ?? 4;
  const unit = indent ? indent.facet(indentUnitFacet()) : '    ';
  const position = `Ln ${status.line}, Col ${status.column}${
    status.selections > 1
      ? ` (${status.selections} selections)`
      : status.selected > 0
        ? ` (${status.selected} selected)`
        : ''
  }`;
  const indentation = unit.startsWith('\t') ? `Tab size: ${tabSize}` : `Spaces: ${unit.length}`;
  const encoding = doc ? `${doc.format.encoding}${doc.format.bom ? ' with BOM' : ''}` : '';

  return (
    <footer
      className="flex h-(--statusbar-h) shrink-0 items-stretch border-t border-line bg-bg px-1.5 text-[11px]"
      aria-label="Status bar"
    >
      <Item label={problemsLabel(counts)} onClick={() => showPanel('problems', true)}>
        <span className="sr-only">Problems: </span>
        <CircleAlert className="size-3" />
        <span>{counts.errors}</span>
        <span className="sr-only">{counts.errors === 1 ? ' error, ' : ' errors, '}</span>
        <TriangleAlert className="ml-1 size-3" />
        <span>{counts.warnings}</span>
        <span className="sr-only">{counts.warnings === 1 ? ' warning' : ' warnings'}</span>
      </Item>
      <GitStatus />
      <PluginStatusItems alignment="left" />
      {chord && (
        <span className="flex items-center px-2 text-text-2">
          ({displayKey(chord)}) was pressed. Waiting for the second key…
        </span>
      )}
      <span className="flex-1" />
      {doc && (
        <>
          <Item
            label="Go to line (Ctrl+G)"
            text={position}
            hint="go to line (Ctrl+G)"
            onClick={() => void executeCommand('quickOpen.goToLine')}
          >
            {position}
          </Item>
          <Item
            label="Change indentation"
            text={indentation}
            hint="change indentation"
            onClick={() => void executeCommand('editor.changeIndentation')}
          >
            {indentation}
          </Item>
          <Item
            label="Change encoding"
            text={encoding}
            hint="change encoding"
            onClick={() => void executeCommand('editor.changeEncoding')}
          >
            {encoding}
          </Item>
          <Item
            label="Change line endings"
            text={doc.format.crlf ? 'CRLF' : 'LF'}
            hint="change line endings"
            onClick={() => void executeCommand('editor.changeEol')}
          >
            {doc.format.crlf ? 'CRLF' : 'LF'}
          </Item>
          <Item
            label="Change language"
            text={languageNameOf(doc.language)}
            hint="change language"
            onClick={() => void executeCommand('editor.changeLanguage')}
          >
            {languageNameOf(doc.language)}
          </Item>
          <LanguageStatus />
        </>
      )}
      <NotebookKernelStatus />
      <PluginStatusItems alignment="right" />
      <Item label="Notifications" iconOnly className={toasts ? 'text-text-2' : undefined}>
        <Bell className="size-3" />
      </Item>
    </footer>
  );
}

// The indent unit facet, without importing all of @codemirror/language into the status bar's
// first render path twice.
import { indentUnit } from '@codemirror/language';
function indentUnitFacet() {
  return indentUnit;
}
