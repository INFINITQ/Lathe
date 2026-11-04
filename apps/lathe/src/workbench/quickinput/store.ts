// The quick input: one box for quick open (Ctrl+P), commands (">"), go to line (":") and any
// "pick one of these" question (languages, line endings, encodings…).

import type { ReactNode } from 'react';
import { create } from 'zustand';

export interface QuickItem {
  id: string;
  label: string;
  /** Matched positions in `label`, highlighted. */
  matches?: number[];
  description?: string;
  /** Shown on the right (a keybinding, a count…). */
  hint?: string;
  icon?: ReactNode;
  /** A heading above this item ("recently opened", "files"…). */
  group?: string;
  run?: (options: { side: boolean }) => void;
}

interface QuickState {
  open: boolean;
  /** quickOpen: the box interprets its prefix; pick: a fixed list of choices; input: free text. */
  mode: 'quickOpen' | 'pick' | 'input';
  /** In input mode, the line under the box ("Press Enter to rename"). */
  prompt: string;
  resolveInput: ((value: string | null) => void) | null;
  value: string;
  placeholder: string;
  pickItems: QuickItem[];
  /** Which item of a pick list starts highlighted. */
  pickActive: number;
  resolvePick: ((item: QuickItem | null) => void) | null;
}

export const useQuickInput = create<QuickState>(() => ({
  open: false,
  mode: 'quickOpen',
  value: '',
  placeholder: '',
  pickItems: [],
  pickActive: 0,
  resolvePick: null,
  prompt: '',
  resolveInput: null,
}));

/** Opens quick open with `prefix` already typed (">" for commands, ":" for a line…). */
export function openQuickOpen(prefix = '') {
  const state = useQuickInput.getState();
  state.resolvePick?.(null);
  useQuickInput.setState({
    open: true,
    mode: 'quickOpen',
    value: prefix,
    placeholder: 'Search files by name (> for commands, : for a line, ? for help)',
    resolvePick: null,
  });
}

/** Asks you to pick one item; resolves with it, or null if you pressed Escape. */
export function quickPick(
  items: QuickItem[],
  options: { placeholder: string; active?: number },
): Promise<QuickItem | null> {
  useQuickInput.getState().resolvePick?.(null);
  return new Promise((resolve) => {
    useQuickInput.setState({
      open: true,
      mode: 'pick',
      value: '',
      placeholder: options.placeholder,
      pickItems: items,
      pickActive: options.active ?? 0,
      resolvePick: resolve,
    });
  });
}

export function closeQuickInput(picked: QuickItem | null = null, text: string | null = null) {
  const { resolvePick, resolveInput } = useQuickInput.getState();
  useQuickInput.setState({ open: false, resolvePick: null, resolveInput: null, value: '' });
  resolvePick?.(picked);
  resolveInput?.(text);
}

/** Asks for a line of text; resolves with it, or null if you pressed Escape. */
export function quickInputText(options: {
  placeholder: string;
  value?: string;
  prompt?: string;
}): Promise<string | null> {
  const state = useQuickInput.getState();
  state.resolvePick?.(null);
  state.resolveInput?.(null);
  return new Promise((resolve) => {
    useQuickInput.setState({
      open: true,
      mode: 'input',
      value: options.value ?? '',
      placeholder: options.placeholder,
      prompt: options.prompt ?? 'Press Enter to confirm, or Escape to cancel.',
      pickItems: [],
      resolvePick: null,
      resolveInput: resolve,
    });
  });
}
