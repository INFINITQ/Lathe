import { useRef } from 'react';
import { cn } from '../lib/cn';

/**
 * A drag handle between two panes: a 1px line with a wider invisible grab area. Reports the
 * pointer's movement since the drag started.
 */
export function Sash({
  direction,
  onStart,
  onMove,
  onEnd,
  onReset,
  className,
  label,
}: {
  /** "vertical" sits between left and right panes; "horizontal" between top and bottom. */
  direction: 'vertical' | 'horizontal';
  onStart?: () => void;
  onMove: (delta: number) => void;
  onEnd?: () => void;
  /** Double-click: back to the default size. */
  onReset?: () => void;
  className?: string;
  label: string;
}) {
  const start = useRef(0);
  const vertical = direction === 'vertical';
  return (
    // Pointer only, so hidden from screen readers.
    <div
      aria-hidden="true"
      title={label}
      className={cn(
        'sash group relative z-10 shrink-0 bg-line',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = vertical ? event.clientX : event.clientY;
        document.body.dataset.resizing = vertical ? 'col' : 'row';
        onStart?.();
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onMove((vertical ? event.clientX : event.clientY) - start.current);
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        delete document.body.dataset.resizing;
        onEnd?.();
      }}
      onDoubleClick={onReset}
    >
      {/* A wider, invisible grab area that lights up in the accent colour while dragging. */}
      <div
        className={cn(
          'absolute transition-colors delay-150 duration-(--dur) group-hover:bg-accent-fg/50 group-active:bg-accent-fg',
          vertical ? '-inset-x-[2px] inset-y-0' : '-inset-y-[2px] inset-x-0',
        )}
      />
    </div>
  );
}
