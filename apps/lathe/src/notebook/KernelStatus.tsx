// The status bar's kernel item while a notebook is the active editor: which kernel, and whether
// it's busy. Clicking it picks another kernel.

import { notebookFor } from './document';
import { useKernels } from './kernels';
import { getDocument, useDocumentsVersion } from '../editor/documents';
import { useEditors } from '../workbench/editors/store';

export function NotebookKernelStatus() {
  useDocumentsVersion();
  const docId = useEditors((s) => {
    const group = s.groups.find((g) => g.id === s.activeGroup);
    const tab = group?.tabs.find((t) => t.id === group.activeTab);
    return tab?.kind === 'notebook' ? (tab.docId ?? null) : null;
  });
  const status = useKernels((s) => (docId ? s.status[docId] : undefined));
  const label = useKernels((s) => (docId ? s.label[docId] : undefined));
  const doc = docId ? getDocument(docId) : undefined;
  if (!doc) return null;
  const text = label
    ? `${label}${status && status !== 'idle' ? ` · ${status === 'dead' ? 'stopped' : status}` : ''}`
    : 'Select a kernel';
  return (
    <button
      type="button"
      title="Select a kernel"
      aria-label={`Notebook kernel: ${text}`}
      onClick={() => void notebookFor(doc).selectKernel()}
      className="flex h-full items-center gap-1.5 px-1.5 text-text-3 hover:bg-hover hover:text-text"
    >
      <span
        aria-hidden="true"
        className={
          !label || status === 'dead'
            ? 'size-1.5 rounded-full border border-text-3'
            : 'size-1.5 rounded-full bg-accent-fg'
        }
      />
      {text}
    </button>
  );
}
