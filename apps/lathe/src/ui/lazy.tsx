// Views that most sessions never open (the terminal, the debugger's views, the diff and notebook
// editors…) load the first time they show instead of at start-up, so the window paints sooner.

import { type ComponentType, Suspense, lazy } from 'react';

/** A component whose module loads the first time it renders (nothing shows meanwhile). */
export function lazyView<P extends object>(
  load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: await load() }));
  function LazyView(props: P) {
    return (
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyView;
}
