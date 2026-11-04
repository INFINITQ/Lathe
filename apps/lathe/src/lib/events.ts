/** A tiny typed event emitter. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

/** Runs `fn` at most once per `ms`, always with the latest arguments, ending on the last call. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: A | undefined;
  const run = () => {
    timer = undefined;
    if (last) fn(...last);
  };
  const debounced = (...args: A) => {
    last = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

/** A random id (UUIDv4 without the dashes' meaning): letters, digits and dashes only. */
export function newId(): string {
  return crypto.randomUUID();
}
