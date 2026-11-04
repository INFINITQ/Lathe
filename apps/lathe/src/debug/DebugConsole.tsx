// The Debug console: what the program and the adapter print, and a line to evaluate expressions
// in the paused frame (↑ and ↓ for history, Tab for completions when the adapter has them).

import { Eraser } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { VariableNode } from './DebugViews';
import { completionsFor, evaluateInConsole } from './manager';
import { type ConsoleEntry, clearConsole, useDebug } from './store';

const history: string[] = [];

function Line({ entry }: { entry: ConsoleEntry }) {
  const text = entry.text.endsWith('\n') ? entry.text.slice(0, -1) : entry.text;
  if (entry.variablesReference && entry.sessionId) {
    return (
      <div role="tree" aria-label={text}>
        <VariableNode
          sessionId={entry.sessionId}
          node={{ name: '', value: text, variablesReference: entry.variablesReference }}
          depth={0}
          path={`console:${entry.id}`}
          parentRef={0}
          label={text}
        />
      </div>
    );
  }
  if (entry.kind === 'input') {
    return (
      <div className="text-text-3">
        <span className="text-accent-fg">›</span> {text}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'break-words whitespace-pre-wrap',
        entry.kind === 'error' && 'text-danger',
        entry.kind === 'info' && 'text-text-3',
        entry.kind === 'output' && entry.category === 'stderr' && 'text-danger',
        entry.kind === 'output' && entry.category === 'console' && 'text-text-2',
        entry.kind === 'output' && entry.category === 'important' && 'text-warning',
      )}
    >
      {text}
    </div>
  );
}

export function DebugConsoleView() {
  const entries = useDebug((s) => s.console);
  const active = useDebug((s) => s.sessions.length > 0);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-debug-console>
      <div
        ref={list}
        role="log"
        aria-label="Debug console"
        className="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[12px] leading-[1.6]"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        {!entries.length && (
          <p className="font-sans text-[11.5px] text-text-3">
            {active
              ? 'Output from the program shows here.'
              : 'Start debugging (F5) to see output here and evaluate expressions.'}
          </p>
        )}
        {entries.map((entry) => (
          <Line key={entry.id} entry={entry} />
        ))}
      </div>
      <ConsoleInput active={active} />
    </div>
  );
}

function ConsoleInput({ active }: { active: boolean }) {
  const [value, setValue] = useState('');
  const [choices, setChoices] = useState<string[]>([]);
  const at = useRef(history.length);
  const input = useRef<HTMLInputElement>(null);

  const complete = async () => {
    const el = input.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const targets = await completionsFor(value, caret + 1);
    if (!targets.length) return;
    const word = /[\w$.]*$/.exec(value.slice(0, caret))?.[0] ?? '';
    const apply = (t: (typeof targets)[number]) => {
      const insert = t.text ?? t.label;
      const start = t.start !== undefined ? t.start - 1 : caret - word.split('.').at(-1)!.length;
      const end = t.length !== undefined ? start + t.length : caret;
      const next = value.slice(0, start) + insert + value.slice(end);
      setValue(next);
      setChoices([]);
      requestAnimationFrame(() =>
        el.setSelectionRange(start + insert.length, start + insert.length),
      );
    };
    if (targets.length === 1) apply(targets[0]!);
    else setChoices(targets.slice(0, 40).map((t) => t.label));
  };

  return (
    <div className="relative shrink-0 border-t border-line">
      {choices.length > 0 && (
        <div
          role="listbox"
          aria-label="Completions"
          className="absolute bottom-full left-6 mb-1 max-h-48 min-w-48 overflow-auto rounded-md border border-line-strong bg-overlay py-1 font-mono text-[12px] shadow-pop"
        >
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full px-2 py-0.5 text-left hover:bg-active"
              onMouseDown={(e) => {
                e.preventDefault();
                const word = /[\w$]*$/.exec(value)?.[0] ?? '';
                setValue(value.slice(0, value.length - word.length) + choice);
                setChoices([]);
              }}
            >
              {choice}
            </button>
          ))}
        </div>
      )}
      <div className="flex h-8 items-center gap-2 px-3">
        <span className="font-mono text-[12px] text-accent-fg" aria-hidden="true">
          ›
        </span>
        <input
          ref={input}
          aria-label="Debug console input"
          disabled={!active}
          placeholder={
            active ? 'Evaluate an expression in the paused frame' : 'Start debugging to evaluate'
          }
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-text outline-none placeholder:text-text-4"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setChoices([]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              e.preventDefault();
              if (history.at(-1) !== value) history.push(value);
              at.current = history.length;
              setValue('');
              setChoices([]);
              void evaluateInConsole(value);
            } else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              at.current = Math.max(0, at.current - 1);
              setValue(history[at.current] ?? '');
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              at.current = Math.min(history.length, at.current + 1);
              setValue(history[at.current] ?? '');
            } else if (e.key === 'Tab') {
              e.preventDefault();
              void complete();
            } else if (e.key === 'Escape') {
              setChoices([]);
            }
          }}
        />
      </div>
    </div>
  );
}

/** The panel's buttons while the Debug console shows. */
export function DebugConsoleActions() {
  return (
    <button
      type="button"
      aria-label="Clear debug console"
      title="Clear debug console"
      className="mr-1 grid size-6 place-items-center self-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
      onClick={clearConsole}
    >
      <Eraser className="size-3.5" />
    </button>
  );
}
