import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { type PanelId, showPanel, useLayout } from './layout';
import { OutputActions, OutputView, ProblemsView } from './ProblemsView';
import { TerminalActions, TerminalPanel } from './terminal/TerminalPanel';
import { DebugConsoleActions, DebugConsoleView } from '../debug/DebugConsole';
import { useInteractive } from '../notebook/interactive';
import { InteractiveActions, InteractiveView } from '../notebook/InteractiveView';

const TABS: { id: PanelId; label: string }[] = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'debugConsole', label: 'Debug console' },
  { id: 'interactive', label: 'Interactive' },
];

/** The bottom panel: problems, output, terminals and the debug console. */
export function Panel() {
  const panel = useLayout((s) => s.panel);
  const maximized = useLayout((s) => s.panelMaximized);
  // The Interactive tab shows once # %% cells have run.
  const interactive = useInteractive((s) => s.entries.length > 0);
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" aria-label="Panel" role="region">
      <div className="flex h-8 shrink-0 items-stretch pr-1.5 pl-2">
        <div role="tablist" className="flex items-stretch gap-3">
          {TABS.filter((tab) => tab.id !== 'interactive' || interactive || panel === tab.id).map(
            (tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={panel === tab.id}
                onClick={() => showPanel(tab.id)}
                className={cn(
                  'relative px-1 text-[11px] tracking-wide uppercase',
                  panel === tab.id ? 'text-text' : 'text-text-3 hover:text-text-2',
                )}
              >
                {tab.label}
                {panel === tab.id && (
                  <span
                    className="absolute inset-x-1 bottom-0 h-px bg-accent-fg"
                    aria-hidden="true"
                  />
                )}
              </button>
            ),
          )}
        </div>
        <span className="flex-1" />
        {panel === 'terminal' && <TerminalActions />}
        {panel === 'output' && <OutputActions />}
        {panel === 'debugConsole' && <DebugConsoleActions />}
        {panel === 'interactive' && <InteractiveActions />}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            title={maximized ? 'Restore panel size' : 'Maximize panel'}
            className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            onClick={() => useLayout.setState({ panelMaximized: !maximized })}
          >
            {maximized ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Close panel"
            title="Close panel (Ctrl+J)"
            className="grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            onClick={() => useLayout.setState({ panelVisible: false, panelMaximized: false })}
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      {panel === 'terminal' ? (
        <div className="min-h-0 flex-1">
          <TerminalPanel />
        </div>
      ) : panel === 'debugConsole' ? (
        <div className="min-h-0 flex-1">
          <DebugConsoleView />
        </div>
      ) : panel === 'interactive' ? (
        <div className="min-h-0 flex-1">
          <InteractiveView />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {panel === 'problems' ? <ProblemsView /> : <OutputView />}
        </div>
      )}
    </div>
  );
}
