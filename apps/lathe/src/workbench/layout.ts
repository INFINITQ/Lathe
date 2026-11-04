// What the workbench shows: sidebar (which view, how wide), bottom panel, zen mode.

import { create } from 'zustand';

export type ViewId = 'explorer' | 'search' | 'scm' | 'debug' | 'plugins';
export type PanelId = 'problems' | 'output' | 'terminal' | 'debugConsole' | 'interactive';

interface LayoutState {
  sidebarVisible: boolean;
  sidebarWidth: number;
  view: ViewId;
  panelVisible: boolean;
  panelHeight: number;
  panel: PanelId;
  panelMaximized: boolean;
  zen: boolean;
  /** The Outline section under the Explorer's files. */
  outlineOpen: boolean;
}

export const useLayout = create<LayoutState>(() => ({
  sidebarVisible: true,
  sidebarWidth: 260,
  view: 'explorer',
  panelVisible: false,
  panelHeight: 240,
  panel: 'problems',
  panelMaximized: false,
  zen: false,
  outlineOpen: false,
}));

export const SIDEBAR_MIN = 170;
export const SIDEBAR_MAX = 640;
export const PANEL_MIN = 100;

/** Shows a view in the sidebar; asking for the one already shown hides the sidebar. */
export function showView(view: ViewId, toggle = false) {
  const state = useLayout.getState();
  if (toggle && state.sidebarVisible && state.view === view) {
    useLayout.setState({ sidebarVisible: false });
    return;
  }
  useLayout.setState({ view, sidebarVisible: true, zen: false });
  // Focus the view once it's on screen (one that loads on first use takes a few frames).
  let frames = 0;
  const focus = () => {
    const el = document.querySelector<HTMLElement>(`[data-view="${view}"] [data-autofocus]`);
    if (el) el.focus();
    else if (++frames < 60) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
}

export function toggleSidebar() {
  useLayout.setState((s) => ({ sidebarVisible: !s.sidebarVisible }));
}

export function showPanel(panel: PanelId, toggle = false) {
  const state = useLayout.getState();
  if (toggle && state.panelVisible && state.panel === panel) {
    useLayout.setState({ panelVisible: false });
    return;
  }
  useLayout.setState({ panel, panelVisible: true, zen: false });
}

export function togglePanel() {
  useLayout.setState((s) => ({ panelVisible: !s.panelVisible }));
}

export function toggleZen() {
  useLayout.setState((s) => ({ zen: !s.zen }));
}
