// Promise-based modal questions ("Save changes to main.py?"), shown by <DialogHost />.

import { create } from 'zustand';

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface Question {
  title: string;
  message?: string;
  buttons: DialogButton[];
  /** The answer when you press Escape or click outside. */
  cancelId: string;
}

interface PendingQuestion extends Question {
  resolve: (answer: string) => void;
}

interface DialogState {
  question: PendingQuestion | null;
}

export const useDialogs = create<DialogState>(() => ({ question: null }));

const queue: PendingQuestion[] = [];

function showNext() {
  if (useDialogs.getState().question) return;
  const next = queue.shift();
  if (next) useDialogs.setState({ question: next });
}

/** Asks a question and resolves with the id of the button chosen. */
export function ask(question: Question): Promise<string> {
  return new Promise((resolve) => {
    queue.push({
      ...question,
      resolve: (answer) => {
        useDialogs.setState({ question: null });
        resolve(answer);
        showNext();
      },
    });
    showNext();
  });
}

/** "Save changes to x?" with Save / Don't save / Cancel. */
export function askToSave(name: string, count = 1): Promise<'save' | 'discard' | 'cancel'> {
  return ask({
    title: count > 1 ? `Save changes to ${count} files?` : `Save changes to ${name}?`,
    message: "Your changes will be lost if you don't save them.",
    buttons: [
      { id: 'save', label: count > 1 ? 'Save all' : 'Save', primary: true },
      { id: 'discard', label: "Don't save" },
      { id: 'cancel', label: 'Cancel' },
    ],
    cancelId: 'cancel',
  }) as Promise<'save' | 'discard' | 'cancel'>;
}
