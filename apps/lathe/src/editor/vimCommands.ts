// Vim's ex commands for files, as Lathe's own: :w saves, :q closes the editor, :wq does both.
// (Vim mode itself is the editor.vim setting; editor/setup.ts adds it.)

import type { Extension } from '@codemirror/state';
import { Vim, vim } from '@replit/codemirror-vim';
import { executeCommand } from '../services/commands';

/** Vim mode for an editor, with Lathe's ex commands (editor/setup.ts loads this on demand). */
export function vimMode(): Extension {
  defineVimCommands();
  return vim();
}

let defined = false;

export function defineVimCommands() {
  if (defined) return;
  defined = true;
  Vim.defineEx('write', 'w', () => void executeCommand('file.save'));
  Vim.defineEx('quit', 'q', () => void executeCommand('editor.close'));
  Vim.defineEx('wq', 'wq', () => {
    void (async () => {
      await executeCommand('file.save');
      await executeCommand('editor.close');
    })();
  });
  Vim.defineEx('xit', 'x', () => {
    void (async () => {
      await executeCommand('file.save');
      await executeCommand('editor.close');
    })();
  });
}
