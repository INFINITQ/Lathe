// One terminal, drawn by xterm.js (Hearth's view, adapted). The program runs in Rust and the
// store holds its connection; this view shows its output (starting with what it showed so far),
// types into it and keeps its size in step with the panel.

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { type ITheme, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { type TerminalInfo, backend } from '../../lib/backend';
import { isAbsolute, resolve } from '../../lib/paths';
import { openPath } from '../editors/store';
import { watchTerminal } from './store';

/** ANSI colours for Mono (dark and light), chosen to read well on each background. */
const ANSI = {
  dark: {
    black: '#2a2a2f',
    red: '#f87171',
    green: '#a3e635',
    yellow: '#fcd34d',
    blue: '#93c5fd',
    magenta: '#d8b4fe',
    cyan: '#67e8f9',
    white: '#d4d4d8',
    brightBlack: '#71717a',
    brightRed: '#fca5a5',
    brightGreen: '#d9f99d',
    brightYellow: '#fde68a',
    brightBlue: '#bfdbfe',
    brightMagenta: '#e9d5ff',
    brightCyan: '#a5f3fc',
    brightWhite: '#fafafa',
  },
  light: {
    black: '#27272a',
    red: '#b91c1c',
    green: '#3f6212',
    yellow: '#a16207',
    blue: '#1d4ed8',
    magenta: '#7e22ce',
    cyan: '#0e7490',
    white: '#71717a',
    brightBlack: '#a1a1aa',
    brightRed: '#dc2626',
    brightGreen: '#4d7c0f',
    brightYellow: '#b45309',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#52525b',
  },
};

function themeNow(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    background: v('--bg'),
    foreground: v('--code-fg'),
    cursor: v('--accent-fg'),
    cursorAccent: v('--bg'),
    selectionBackground: v('--selection'),
    scrollbarSliderBackground: v('--scrollbar'),
    scrollbarSliderHoverBackground: v('--scrollbar-hover'),
    ...(dark ? ANSI.dark : ANSI.light),
  };
}

/** Measuring the font before it has loaded would size every cell wrong. */
const fontReady = document.fonts.load("13px 'JetBrains Mono Variable'").catch(() => []);

/** "src\main.py:12:5" or "main.cpp(12,5)" in output: a link that opens the file there. */
const FILE_LINK =
  /((?:[a-zA-Z]:)?[\w.\-\\/]+\.[a-zA-Z0-9]{1,8})(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))/;

export function TerminalView({ info, active }: { info: TerminalInfo; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];

    void fontReady.then(() => {
      if (disposed) return;
      const style = getComputedStyle(document.documentElement);
      const terminal = new Terminal({
        fontFamily: style.getPropertyValue('--font-code').trim() || 'monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 10000,
        allowProposedApi: true,
        theme: themeNow(),
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new SearchAddon());
      const unicode = new Unicode11Addon();
      terminal.loadAddon(unicode);
      terminal.unicode.activeVersion = '11';
      terminal.loadAddon(
        new WebLinksAddon((_event, url) => {
          void backend().openLink(url);
        }),
      );
      // File paths with line numbers (compiler errors, tracebacks) open in the editor.
      terminal.registerLinkProvider({
        provideLinks: (y, callback) => {
          const line = terminal.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
          const match = FILE_LINK.exec(line);
          if (!match || match.index === undefined) return callback(undefined);
          const [text, file = '', l1, c1, l2, c2] = match;
          const lineNo = Number(l1 ?? l2 ?? 1);
          const column = Number(c1 ?? c2 ?? 1);
          callback([
            {
              text,
              range: {
                start: { x: match.index + 1, y },
                end: { x: match.index + text.length, y },
              },
              activate: () => {
                const path = isAbsolute(file) ? file : resolve(info.cwd, file);
                void openPath(path, { selection: { line: lineNo, column } });
              },
            },
          ]);
        },
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown' || !event.ctrlKey) return true;
        const key = event.key.toLowerCase();
        // Ctrl+C copies a selection (and interrupts the program otherwise); Ctrl+V pastes.
        if (key === 'c' && !event.shiftKey && terminal.hasSelection()) {
          void navigator.clipboard.writeText(terminal.getSelection());
          terminal.clearSelection();
          return false;
        }
        if (key === 'v') return false;
        return true;
      });
      terminal.open(el);
      view.current = { terminal, fit };

      const typed = terminal.onData((data) => {
        void backend()
          .terminal.write(info.id, data)
          .catch(() => {});
      });
      const resized = terminal.onResize(({ cols, rows }) => {
        void backend()
          .terminal.resize(info.id, cols, rows)
          .catch(() => {});
      });
      const refit = () => {
        if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return;
        fit.fit();
      };
      const sizes = new ResizeObserver(() => requestAnimationFrame(refit));
      sizes.observe(el);
      refit();
      const themes = new MutationObserver(() => {
        terminal.options.theme = themeNow();
      });
      themes.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style'],
      });
      const unwatch = watchTerminal(info.id, (event) => {
        if (disposed) return;
        if (event.type === 'output') {
          terminal.write(event.data);
        } else {
          const code = event.code == null ? '' : ` with code ${event.code}`;
          terminal.write(`\r\n\x1b[2m[Exited${code}.]\x1b[0m\r\n`);
        }
      });
      if (active) terminal.focus();

      cleanup.push(() => {
        unwatch();
        sizes.disconnect();
        themes.disconnect();
        typed.dispose();
        resized.dispose();
        terminal.dispose();
        view.current = null;
      });
    });

    return () => {
      disposed = true;
      cleanup.forEach((dispose) => dispose());
    };
    // One xterm per terminal; `active` only moves the focus (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.id]);

  useEffect(() => {
    if (!active || !view.current) return;
    requestAnimationFrame(() => {
      view.current?.fit.fit();
      view.current?.terminal.focus();
    });
  }, [active]);

  return (
    <div
      ref={box}
      className="terminal-host h-full w-full"
      data-terminal={info.id}
      data-terminal-active={active}
    />
  );
}
