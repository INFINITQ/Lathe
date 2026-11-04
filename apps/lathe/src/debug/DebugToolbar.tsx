// The floating debug toolbar over the editors: continue or pause, step over, into and out,
// restart and stop. It shows while a session runs; drag its grip to move it sideways.

import {
  ArrowDownToDot,
  ArrowUpFromDot,
  GripVertical,
  Pause,
  Play,
  Redo,
  RotateCcw,
  Square,
} from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { keyFor } from '../services/keybindings';
import { restartDebugging, stopDebugging, threadCommand } from './manager';
import { debugStateOf, useDebug } from './store';

let savedOffset = 0;

function ToolButton({
  label,
  command,
  fallback,
  onClick,
  disabled,
  children,
}: {
  label: string;
  command: string;
  fallback: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const title = `${label} (${keyFor(command) ?? fallback})`;
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={disabled}
      className="grid size-6 place-items-center rounded-sm text-text-2 hover:bg-hover hover:text-text disabled:text-text-4 disabled:hover:bg-transparent [&>svg]:size-3.5"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function DebugToolbar() {
  const state = useDebug((s) => debugStateOf(s));
  const [offset, setOffset] = useState(savedOffset);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  if (state === 'inactive') return null;
  const stopped = state === 'stopped';

  return (
    <div
      role="toolbar"
      aria-label="Debug toolbar"
      className="absolute top-1 left-1/2 z-30 flex h-7 items-center gap-px rounded-md border border-line-strong bg-raised px-0.5 shadow-pop"
      style={{ transform: `translateX(calc(-50% + ${offset}px))` }}
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-3.5 cursor-grab place-items-center text-text-4 active:cursor-grabbing"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, offset };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const next = drag.current.offset + e.clientX - drag.current.x;
          savedOffset = next;
          setOffset(next);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <GripVertical className="size-3" />
      </span>
      {stopped ? (
        <ToolButton
          label="Continue"
          command="debug.continue"
          fallback="F5"
          onClick={() => void threadCommand('continue')}
        >
          <Play />
        </ToolButton>
      ) : (
        <ToolButton
          label="Pause"
          command="debug.pause"
          fallback="F6"
          onClick={() => void threadCommand('pause')}
        >
          <Pause />
        </ToolButton>
      )}
      <ToolButton
        label="Step over"
        command="debug.stepOver"
        fallback="F10"
        disabled={!stopped}
        onClick={() => void threadCommand('next')}
      >
        <Redo />
      </ToolButton>
      <ToolButton
        label="Step into"
        command="debug.stepInto"
        fallback="F11"
        disabled={!stopped}
        onClick={() => void threadCommand('stepIn')}
      >
        <ArrowDownToDot />
      </ToolButton>
      <ToolButton
        label="Step out"
        command="debug.stepOut"
        fallback="Shift+F11"
        disabled={!stopped}
        onClick={() => void threadCommand('stepOut')}
      >
        <ArrowUpFromDot />
      </ToolButton>
      <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
      <ToolButton
        label="Restart"
        command="debug.restart"
        fallback="Ctrl+Shift+F5"
        onClick={() => void restartDebugging()}
      >
        <RotateCcw />
      </ToolButton>
      <ToolButton
        label="Stop"
        command="debug.stop"
        fallback="Shift+F5"
        onClick={() => void stopDebugging()}
      >
        <Square className="text-danger" />
      </ToolButton>
    </div>
  );
}
