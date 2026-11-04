// Output channels ("Run", "Lathe"…): text logs shown in the panel's Output tab.

import { create } from 'zustand';

const MAX_CHARS = 200_000;

export const useOutput = create<{ channels: Record<string, string>; active: string }>(() => ({
  channels: {},
  active: 'Run',
}));

export function appendOutput(channel: string, text: string) {
  useOutput.setState((s) => {
    const next = (s.channels[channel] ?? '') + text;
    return { channels: { ...s.channels, [channel]: next.slice(-MAX_CHARS) } };
  });
}

export function clearOutput(channel: string) {
  useOutput.setState((s) => ({ channels: { ...s.channels, [channel]: '' } }));
}
