import { CircleAlert, Eraser, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { basename, relative } from '../lib/paths';
import { clearOutput, useOutput } from '../services/output';
import { allProblems, useProblems } from '../services/problems';
import { openPath } from './editors/store';
import { useWorkspace } from './workspaceStore';

const ICON = {
  error: <CircleAlert className="size-3.5 shrink-0 text-danger" />,
  warning: <TriangleAlert className="size-3.5 shrink-0 text-warning" />,
  info: <Info className="size-3.5 shrink-0 text-info" />,
};

/** The Problems tab: every error and warning, click to go there. */
export function ProblemsView() {
  const state = useProblems();
  const root = useWorkspace((s) => s.root);
  const problems = allProblems(state);
  if (!problems.length) {
    return <p className="px-3 py-1 text-[12px] text-text-3">No problems have been detected.</p>;
  }
  return (
    <ul className="py-1 text-[12px]" aria-label="Problems">
      {problems.map((p, i) => (
        <li key={i}>
          <button
            type="button"
            className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-hover"
            onClick={() => void openPath(p.path, { selection: { line: p.line, column: p.column } })}
          >
            <span className="self-center">{ICON[p.severity]}</span>
            <span className="min-w-0 flex-1 truncate text-text">{p.message}</span>
            <span className="shrink-0 text-[11px] text-text-3">
              {root ? relative(root, p.path) : basename(p.path)} [{p.line}, {p.column}]
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The Output tab: the active channel's text, kept scrolled to the end while it grows. */
export function OutputView() {
  const channels = useOutput((s) => s.channels);
  const active = useOutput((s) => s.active);
  const text = channels[active] ?? '';
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [text]);
  return (
    <pre
      className="px-3 py-1 font-mono text-[12px] whitespace-pre-wrap text-text-2 select-text"
      aria-label="Output"
    >
      {text || 'Output from builds, tasks and language servers appears here.'}
      <span ref={end} />
    </pre>
  );
}

/** The Output tab's header: which channel to show, and clearing it. */
export function OutputActions() {
  const channels = useOutput((s) => s.channels);
  const active = useOutput((s) => s.active);
  const names = Object.keys(channels).sort();
  if (!names.includes(active)) names.unshift(active);
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label="Output channel"
        value={active}
        onChange={(e) => useOutput.setState({ active: e.target.value })}
        className="h-6 max-w-48 rounded-sm border border-line-strong bg-raised px-1.5 text-[11.5px] text-text-2 outline-none focus:border-accent-fg"
      >
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Clear output"
        title="Clear output"
        className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
        onClick={() => clearOutput(active)}
      >
        <Eraser className="size-3.5" />
      </button>
    </div>
  );
}

/** Error and warning counts for the status bar. */
export function useProblemCounts(): { errors: number; warnings: number } {
  const state = useProblems();
  const problems = allProblems(state);
  return {
    errors: problems.filter((p) => p.severity === 'error').length,
    warnings: problems.filter((p) => p.severity === 'warning').length,
  };
}
