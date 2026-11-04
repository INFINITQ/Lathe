// Toasts in the bottom-right corner. Information goes away by itself; errors and anything
// with actions stay until dismissed.

import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  actions?: ToastAction[];
}

interface ToastState {
  toasts: Toast[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;
const MAX_TOASTS = 4;

export function notify(
  kind: ToastKind,
  message: string,
  options: { detail?: string; actions?: ToastAction[]; timeout?: number } = {},
): number {
  const id = nextId++;
  const toast: Toast = { id, kind, message, detail: options.detail, actions: options.actions };
  useToasts.setState((s) => ({ toasts: [...s.toasts, toast].slice(-MAX_TOASTS) }));
  const sticky = kind === 'error' || (options.actions?.length ?? 0) > 0;
  const timeout = options.timeout ?? (sticky ? 0 : 5000);
  if (timeout > 0) setTimeout(() => dismiss(id), timeout);
  return id;
}

export function dismiss(id: number) {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
