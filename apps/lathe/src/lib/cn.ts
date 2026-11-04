import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge must know Lathe's design tokens, or it could treat `text-text-2` (a colour)
// and `text-[13px]` (a size) as the same kind of class and drop one.
const merge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        'bg',
        'raised',
        'overlay',
        'hover',
        'active',
        'line',
        'line-strong',
        'text',
        'text-2',
        'text-3',
        'text-4',
        'accent',
        'accent-fg',
        'accent-ink',
        'accent-soft',
        'danger',
        'warning',
        'info',
        'success',
      ],
      shadow: ['pop'],
      radius: ['sm', 'md'],
    },
  },
});

/** Joins class names, letting later Tailwind classes override earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
