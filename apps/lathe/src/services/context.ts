// Context keys for "when" clauses: what has focus, what's visible, what kind of file is open.
// Parts of the UI set their keys; keybindings and menus read a snapshot.

import type { Context } from './when';

const values: Context = {};
const listeners = new Set<() => void>();

export function setContext(key: string, value: unknown) {
  if (values[key] === value) return;
  values[key] = value;
  listeners.forEach((l) => l());
}

export function getContext(key: string): unknown {
  return values[key];
}

export function contextSnapshot(): Context {
  // Focus is read live: it changes without anyone telling us.
  const active = document.activeElement;
  const inEditor = !!active?.closest('.cm-editor');
  return {
    ...values,
    editorFocus: inEditor,
    editorTextFocus: inEditor && !!active?.closest('.cm-content'),
    inputFocus:
      !inEditor &&
      (active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)),
    explorerFocus: !!active?.closest('[data-view="explorer"]'),
    quickInputVisible: !!document.querySelector('[data-quick-input]'),
    dialogOpen: !!document.querySelector('[role="dialog"], [role="alertdialog"]'),
  };
}

export function onContextChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
