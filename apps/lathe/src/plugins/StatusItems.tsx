// Status bar items plugins show (lathe.window.createStatusBarItem), on the left or the right.

import { executeCommand } from '../services/commands';
import { usePlugins } from './store';

export function PluginStatusItems({ alignment }: { alignment: 'left' | 'right' }) {
  // The whole list (a stable reference), filtered here: a filtering selector would make a new
  // array on every read and render forever.
  const all = usePlugins((s) => s.statusItems);
  const items = all.filter((i) => i.visible && i.alignment === alignment);
  return (
    <>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          title={item.tooltip ?? item.text}
          aria-label={item.tooltip ?? item.text}
          data-plugin-item={item.key}
          disabled={!item.command}
          onClick={() => item.command && void executeCommand(item.command)}
          className="flex h-full items-center px-1.5 text-text-3 hover:bg-hover hover:text-text disabled:hover:bg-transparent disabled:hover:text-text-3"
        >
          {item.text}
        </button>
      ))}
    </>
  );
}
