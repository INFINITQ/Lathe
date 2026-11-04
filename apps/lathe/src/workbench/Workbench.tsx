import { useRef } from 'react';
import { basename } from '../lib/paths';
import { useWorkspace } from './workspaceStore';
import { DebugToolbar } from '../debug/DebugToolbar';
import { Sash } from '../ui/Sash';
import { ActivityRail } from './ActivityRail';
import { EditorArea } from './editors/EditorArea';
import { PANEL_MIN, SIDEBAR_MAX, SIDEBAR_MIN, useLayout } from './layout';
import { Panel } from './Panel';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';

/** The whole window: title bar, activity rail, sidebar, editors, panel and status bar. */
export function Workbench() {
  const root = useWorkspace((w) => w.root);
  const layout = useLayout();
  const start = useRef(0);
  const main = useRef<HTMLDivElement>(null);
  const zen = layout.zen;
  const showSidebar = layout.sidebarVisible && !zen;
  const showPanel = layout.panelVisible && !zen;

  return (
    <div className="lathe-app flex h-full flex-col bg-bg text-text">
      {!zen && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {!zen && <ActivityRail />}
        {showSidebar && (
          <>
            <aside
              className="flex shrink-0 flex-col overflow-hidden bg-bg"
              style={{ width: layout.sidebarWidth }}
              aria-label="Sidebar"
            >
              <Sidebar />
            </aside>
            <Sash
              direction="vertical"
              label="Resize sidebar"
              onStart={() => (start.current = layout.sidebarWidth)}
              onMove={(delta) =>
                useLayout.setState({
                  sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, start.current + delta)),
                })
              }
              onReset={() => useLayout.setState({ sidebarWidth: 260 })}
            />
          </>
        )}
        <main ref={main} className="flex min-w-0 flex-1 flex-col">
          <h1 className="sr-only">
            {root ? `${basename(root)} in Lathe` : 'Lathe, no folder open'}
          </h1>
          {!(showPanel && layout.panelMaximized) && (
            <div className="relative min-h-0 flex-1">
              <EditorArea />
              <DebugToolbar />
            </div>
          )}
          {showPanel && (
            <>
              {!layout.panelMaximized && (
                <Sash
                  direction="horizontal"
                  label="Resize panel"
                  onStart={() => (start.current = layout.panelHeight)}
                  onMove={(delta) => {
                    const max = (main.current?.clientHeight ?? 800) - 120;
                    useLayout.setState({
                      panelHeight: Math.max(PANEL_MIN, Math.min(max, start.current - delta)),
                    });
                  }}
                  onReset={() => useLayout.setState({ panelHeight: 240 })}
                />
              )}
              <div
                className={layout.panelMaximized ? 'min-h-0 flex-1' : 'shrink-0'}
                style={layout.panelMaximized ? undefined : { height: layout.panelHeight }}
              >
                <Panel />
              </div>
            </>
          )}
        </main>
      </div>
      {!zen && <StatusBar />}
    </div>
  );
}
