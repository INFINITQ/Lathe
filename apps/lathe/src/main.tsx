import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { backend } from './lib/backend';
import { applyAppearance } from './lib/theme';
import { setDefaultKeybindings } from './services/keybindings';
import { handleLaunch, restoreDebugState, restoreSession } from './services/session';
import { DEFAULT_KEYBINDINGS, registerWorkbenchCommands } from './workbench/commands';

registerWorkbenchCommands();
setDefaultKeybindings(DEFAULT_KEYBINDINGS);
// Appearance before the first render, so the first frame already has the right colours.
applyAppearance();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The window starts hidden; show it once the first frame has painted, so it never flashes.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    backend()
      .appReady()
      .catch((err: unknown) => console.error('app_ready failed', err));
  }),
);

// Then open what Lathe was started with, or bring back the last session.
void (async () => {
  const boot = backend().boot();
  try {
    restoreDebugState(boot.session);
    if (!(await handleLaunch(boot.launch))) await restoreSession(boot.session);
  } catch (err) {
    console.error('Restoring the session failed', err);
  }
})();
