// Where start-up time goes, from Windows creating the process to the editors being back. Rust
// passes its steps in the boot data; the page marks its own. "Developer: Startup performance"
// shows the report, and the performance budget tests read the same marks.

import { backend } from '../lib/backend';
import { appendOutput, clearOutput, useOutput } from './output';

export type StartupMark = 'script' | 'rendered' | 'shown' | 'restored';

/** Notes that start-up reached a step (only the first time). */
export function markStartup(name: StartupMark) {
  if (!performance.getEntriesByName(`lathe:${name}`).length) performance.mark(`lathe:${name}`);
}

export interface StartupStep {
  label: string;
  /** Milliseconds this step took (from the step before it). */
  ms: number;
}

/** Each step of this launch's start-up that has happened, in order. */
export function startupSteps(): StartupStep[] {
  const rust = backend().boot().startup;
  const origin = performance.timeOrigin;
  const mark = (name: StartupMark) => {
    const entry = performance.getEntriesByName(`lathe:${name}`)[0];
    return entry ? origin + entry.startTime : 0;
  };
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  const points: [string, number][] = [
    ['Windows starts lathe.exe', rust?.process ?? 0],
    ['Rust starts', rust?.main ?? 0],
    ['Settings and the last session are read', rust?.boot ?? 0],
    ['WebView2 starts and asks for the page', origin],
    ['The UI loads and runs its scripts', mark('script')],
    ['React renders the workbench', mark('rendered')],
    ['First paint', paint ? origin + paint.startTime : 0],
    ['The window shows', mark('shown')],
    ['Editors are back', mark('restored')],
  ];
  const steps: StartupStep[] = [];
  let previous = 0;
  for (const [label, at] of points) {
    if (!at) continue;
    if (previous) steps.push({ label, ms: Math.max(0, at - previous) });
    previous = at;
  }
  return steps;
}

/** Writes the report to the "Startup" Output channel and shows it. */
export async function showStartupReport() {
  const steps = startupSteps();
  const total = steps.reduce((sum, s) => sum + s.ms, 0);
  const scripts = performance
    .getEntriesByType('resource')
    .filter((r) => /\.js(\?|$)/.test(r.name)).length;
  const lines = [
    'Start-up of this window (each line: how long that step took)',
    '',
    ...steps.map((s) => `${String(Math.round(s.ms)).padStart(6)} ms  ${s.label}`),
    `${'─'.repeat(6)}`,
    `${String(Math.round(total)).padStart(6)} ms  in all`,
    '',
    `Scripts loaded so far: ${scripts + 1}`,
    '',
  ];
  clearOutput('Startup');
  appendOutput('Startup', lines.join('\n'));
  useOutput.setState({ active: 'Startup' });
  const { showPanel } = await import('../workbench/layout');
  showPanel('output');
}
