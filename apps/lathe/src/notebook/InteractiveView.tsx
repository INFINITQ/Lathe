// The Interactive panel: each # %% cell you ran from a Python file, its code (shortened) and its
// output, newest last.

import { Brush, RotateCcw, Square } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { basename } from '../lib/paths';
import { cn } from '../lib/cn';
import {
  clearInteractive,
  interactiveOwner,
  interactiveSession,
  useInteractive,
} from './interactive';
import { useKernels } from './kernels';
import { Outputs } from './outputs';

export function InteractiveView() {
  const entries = useInteractive((s) => s.entries);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);
  return (
    <div ref={list} role="log" aria-label="Interactive" className="h-full overflow-auto px-3 py-2">
      {!entries.length && (
        <p className="text-[11.5px] text-text-3">
          Start a cell in a Python file with a <code className="font-mono"># %%</code> line, then
          press Shift+Enter in it: its output shows here.
        </p>
      )}
      {entries.map((entry) => {
        const running = entry.status === 'queued' || entry.status === 'running';
        const lines = entry.code.split('\n');
        return (
          <section
            key={entry.id}
            aria-label={`${basename(entry.file)} line ${entry.line}`}
            className="mb-3"
            data-status={entry.status}
          >
            <div className="flex items-baseline gap-2 text-[11px] text-text-3">
              <span className="font-mono">[{running ? '*' : (entry.count ?? ' ')}]</span>
              <span>
                {basename(entry.file)}:{entry.line}
              </span>
              {entry.ms !== null && (
                <span className={cn(entry.status !== 'ok' && 'text-danger')}>
                  {entry.status === 'ok' ? '✓' : '✕'} {(entry.ms / 1000).toFixed(1)}s
                </span>
              )}
            </div>
            <pre className="nb-pre mt-0.5 border-l border-line-strong pl-2 text-text-3">
              {lines.slice(0, 4).join('\n')}
              {lines.length > 4 ? `\n… ${lines.length - 4} more lines` : ''}
            </pre>
            {entry.outputs.length > 0 && <Outputs outputs={entry.outputs} />}
          </section>
        );
      })}
    </div>
  );
}

const button =
  'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text disabled:text-text-4 [&>svg]:size-3.5';

/** The panel's buttons while the Interactive panel shows. */
export function InteractiveActions() {
  const file = useInteractive((s) => s.entries.at(-1)?.file);
  const owner = file ? interactiveOwner(file) : '';
  const status = useKernels((s) => s.status[owner]);
  const label = useKernels((s) => s.label[owner]);
  return (
    <div className="mr-1 flex items-center gap-0.5 self-center">
      {label && (
        <span className="mr-1 max-w-48 truncate text-[11px] text-text-3" title={label}>
          {label} · {status === 'dead' || !status ? 'stopped' : status}
        </span>
      )}
      <button
        type="button"
        aria-label="Interrupt the interactive kernel"
        title="Interrupt"
        className={button}
        disabled={status !== 'busy'}
        onClick={() => void interactiveSession()?.interrupt()}
      >
        <Square />
      </button>
      <button
        type="button"
        aria-label="Restart the interactive kernel"
        title="Restart"
        className={button}
        disabled={!label}
        onClick={() => void interactiveSession()?.restart()}
      >
        <RotateCcw />
      </button>
      <button
        type="button"
        aria-label="Clear the Interactive panel"
        title="Clear"
        className={button}
        onClick={clearInteractive}
      >
        <Brush />
      </button>
    </div>
  );
}
