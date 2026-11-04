import { useEffect, useLayoutEffect } from 'react';
import { allDocuments } from './editor/documents';
import { reconfigureEditor } from './editor/setup';
import { backend } from './lib/backend';
import { applyAppearance, setSystemDark, watchSystemTheme } from './lib/theme';
import { executeCommand } from './services/commands';
import { setContext } from './services/context';
import { installKeybindings } from './services/keybindings';
import { onDocumentSaved } from './editor/documents';
import { lspFilesChanged, stopAllServers } from './lsp/manager';
import { installDebugger, stopAllDebugging } from './debug/manager';
import { installPlugins } from './plugins/manager';
import { markStartup } from './services/startup';
import { installUserKeybindings } from './services/userKeybindings';
import { installUserSnippets } from './services/userSnippets';
import { offerVsCodeImport } from './services/vscodeImport';
import { PointMenuHost } from './ui/Menu';
import { refreshGit, refreshGitSoon, useGit } from './services/git';
import { installMouseNavigation } from './services/navigation';
import { beforeClose, handleLaunch, openDropped, startSessionAutosave } from './services/session';
import { useSettings, watchSettings } from './services/settings';
import { DialogHost } from './workbench/DialogHost';
import { handleTreeChanges, setTreeRoot } from './workbench/explorer/tree';
import { useLayout } from './workbench/layout';
import { QuickInput } from './workbench/quickinput/QuickInput';
import { Toasts } from './workbench/Toasts';
import { Workbench } from './workbench/Workbench';
import { onDiskChanges, useWorkspace } from './workbench/workspaceStore';

/** Adds a DOM listener and returns its remover. */
function listen(target: Window, event: string, handler: () => void): () => void {
  target.addEventListener(event, handler);
  return () => target.removeEventListener(event, handler);
}

export function App() {
  // After React's first commit, before the browser paints it.
  useLayoutEffect(() => markStartup('rendered'), []);

  useEffect(() => {
    // Context keys for keybindings and menus.
    const syncLayout = () => {
      const s = useLayout.getState();
      setContext('sidebarVisible', s.sidebarVisible);
      setContext('panelVisible', s.panelVisible);
      setContext('zen', s.zen);
    };
    syncLayout();
    setContext('hasFolder', !!useWorkspace.getState().root);
    setTreeRoot(useWorkspace.getState().root);

    const stops = [
      installKeybindings((command, args) => void executeCommand(command, args)),
      installUserKeybindings(),
      installUserSnippets(),
      installMouseNavigation(),
      watchSettings(),
      watchSystemTheme(setSystemDark),
      useSettings.subscribe(() => {
        applyAppearance();
        for (const doc of allDocuments())
          for (const view of doc.views) reconfigureEditor(view, doc);
      }),
      useLayout.subscribe(syncLayout),
      useGit.subscribe((s, prev) => {
        if (!!s.repo !== !!prev.repo) setContext('gitRepo', !!s.repo);
      }),
      useWorkspace.subscribe((s, prev) => {
        if (s.root !== prev.root) {
          setContext('hasFolder', !!s.root);
          setTreeRoot(s.root);
          // Servers belong to a folder.
          if (prev.root) {
            void stopAllServers();
            void stopAllDebugging();
          }
          void refreshGit();
        }
      }),
      onDiskChanges(handleTreeChanges),
      onDiskChanges(lspFilesChanged),
      onDiskChanges(() => refreshGitSoon()),
      onDocumentSaved(() => refreshGitSoon()),
      listen(window, 'focus', () => refreshGitSoon()),
      backend().onOpen((launch) => void handleLaunch(launch)),
      backend().onDrop((paths) => void openDropped(paths)),
      backend().window.onCloseRequested(beforeClose),
      startSessionAutosave(),
      installDebugger(),
      installPlugins(),
    ];
    // A first run next to VS Code offers to bring its settings across (after start-up settles).
    const offer = setTimeout(() => void offerVsCodeImport(), 1500);
    return () => {
      clearTimeout(offer);
      stops.forEach((stop) => stop());
    };
  }, []);

  return (
    <>
      <Workbench />
      <QuickInput />
      <DialogHost />
      <Toasts />
      <PointMenuHost />
    </>
  );
}
