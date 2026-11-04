// A sample plugin: the active file's word count in the status bar, and a command (Ctrl+Alt+W)
// that counts the selected words, or the whole file's. It needs no permissions: what it reads
// comes from `lathe.editor`.

/** @param {string} text */
const count = (text) => (text.match(/\S+/g) ?? []).length;

/** @param {import('@lathe/plugin-api').Lathe} lathe */
export function activate(lathe) {
  const item = lathe.window.createStatusBarItem({ alignment: 'right' });
  item.command = 'wordCount.count';
  item.tooltip = 'Words in this file (click to count the selection)';

  lathe.editor.onDidChange((editor) => {
    if (!editor) {
      item.hide();
      return;
    }
    const words = count(editor.text);
    item.text = `${words} ${words === 1 ? 'word' : 'words'}`;
    item.show();
  });

  lathe.commands.register('wordCount.count', async () => {
    const editor = await lathe.editor.active();
    if (!editor) {
      await lathe.window.showInformation('Open a file to count its words.');
      return;
    }
    const { from, to } = editor.selection;
    const whole = from === to;
    const words = count(whole ? editor.text : editor.text.slice(from, to));
    await lathe.window.showInformation(
      `${words} ${words === 1 ? 'word' : 'words'} ${whole ? 'in the file' : 'selected'}.`,
    );
  });
}
