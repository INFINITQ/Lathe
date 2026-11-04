import { AlertDialog } from 'radix-ui';
import { cn } from '../lib/cn';
import { useDialogs } from '../services/dialogs';

/** Shows the question from `ask()` (one at a time). */
export function DialogHost() {
  const question = useDialogs((s) => s.question);
  if (!question) return null;
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) question.resolve(question.cancelId);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <AlertDialog.Content
          className="fixed top-[22%] left-1/2 z-50 w-[min(420px,90vw)] -translate-x-1/2 rounded-md border border-line-strong bg-overlay p-5 text-text shadow-pop"
          onEscapeKeyDown={() => question.resolve(question.cancelId)}
        >
          <AlertDialog.Title className="text-[14px] font-medium">
            {question.title}
          </AlertDialog.Title>
          {question.message ? (
            <AlertDialog.Description className="mt-1.5 text-[12.5px] text-text-2">
              {question.message}
            </AlertDialog.Description>
          ) : (
            <AlertDialog.Description className="sr-only">{question.title}</AlertDialog.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            {question.buttons.map((button) => (
              <button
                key={button.id}
                type="button"
                autoFocus={button.primary}
                className={cn(
                  'h-7 rounded-sm px-3 text-[12.5px]',
                  button.primary
                    ? 'bg-accent font-medium text-accent-ink hover:brightness-95'
                    : 'border border-line-strong hover:bg-hover',
                  button.danger && !button.primary && 'text-danger',
                )}
                onClick={() => question.resolve(button.id)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
