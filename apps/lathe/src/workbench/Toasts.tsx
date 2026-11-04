import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../lib/cn';
import { dismiss, useToasts } from '../services/notifications';

const ICONS = {
  info: <Info className="size-4 text-info" />,
  success: <CircleCheck className="size-4 text-success" />,
  warning: <TriangleAlert className="size-4 text-warning" />,
  error: <CircleAlert className="size-4 text-danger" />,
};

/** Notifications, stacked above the status bar on the right. */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-[calc(var(--statusbar-h)+10px)] z-50 flex w-[380px] flex-col gap-2"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className="toast pointer-events-auto flex gap-2.5 rounded-md border border-line-strong bg-overlay p-3 text-[12.5px] text-text shadow-pop"
        >
          <span className="mt-px shrink-0">{ICONS[toast.kind]}</span>
          <div className="min-w-0 flex-1">
            <p className="leading-snug">{toast.message}</p>
            {toast.detail && (
              <p className="mt-1 text-[11.5px] break-words text-text-3 select-text">
                {toast.detail}
              </p>
            )}
            {toast.actions && toast.actions.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {toast.actions.map((action, i) => (
                  <button
                    key={action.label}
                    type="button"
                    className={cn(
                      'h-6 rounded-sm px-2.5 text-[12px]',
                      i === 0
                        ? 'bg-accent font-medium text-accent-ink hover:brightness-95'
                        : 'border border-line-strong text-text-2 hover:bg-hover hover:text-text',
                    )}
                    onClick={() => {
                      dismiss(toast.id);
                      void action.run();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="grid size-5 shrink-0 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text"
            onClick={() => dismiss(toast.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
