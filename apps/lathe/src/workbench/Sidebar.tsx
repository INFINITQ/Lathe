import { PluginsView } from '../plugins/PluginsView';
import { RunView } from '../run/RunView';
import { Explorer } from './explorer/Explorer';
import { ScmView } from './scm/ScmView';
import { SearchView } from './search/SearchView';
import { type ViewId, useLayout } from './layout';

const TITLES: Record<ViewId, string> = {
  explorer: 'Explorer',
  search: 'Search',
  scm: 'Source control',
  debug: 'Run and debug',
  plugins: 'Plugins',
};

/** The sidebar shows one view at a time. */
export function Sidebar() {
  const view = useLayout((s) => s.view);
  if (view === 'explorer') return <Explorer />;
  if (view === 'debug') return <RunView />;
  if (view === 'search') return <SearchView />;
  if (view === 'scm') return <ScmView />;
  if (view === 'plugins') return <PluginsView />;
  return (
    <div className="flex h-full flex-col" data-view={view}>
      <header className="flex h-(--tabs-h) shrink-0 items-center px-3">
        <h2 className="text-[11px] font-medium tracking-wide text-text-3 uppercase">
          {TITLES[view]}
        </h2>
      </header>
      <p className="px-3 text-[12px] text-text-3" tabIndex={-1} data-autofocus>
        {TITLES[view]} arrives in a later milestone.
      </p>
    </div>
  );
}
