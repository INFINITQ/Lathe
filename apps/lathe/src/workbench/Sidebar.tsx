import { lazyView } from '../ui/lazy';
import { Explorer } from './explorer/Explorer';
import { type ViewId, useLayout } from './layout';

// The Explorer is what shows at start; the other views load the first time you open them.
const PluginsView = lazyView(() => import('../plugins/PluginsView').then((m) => m.PluginsView));
const RunView = lazyView(() => import('../run/RunView').then((m) => m.RunView));
const ScmView = lazyView(() => import('./scm/ScmView').then((m) => m.ScmView));
const SearchView = lazyView(() => import('./search/SearchView').then((m) => m.SearchView));

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
