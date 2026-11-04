import { ArrowDown, ArrowUp, GitBranch, LoaderCircle, RefreshCw } from 'lucide-react';
import { useGit } from '../services/git';
import { showBranchPicker, syncWithRemote } from './scm/actions';

const item =
  'flex h-full items-center gap-1 px-1.5 text-text-3 transition-colors duration-(--dur) hover:bg-hover hover:text-text';

/** The status bar's branch (click to switch) and sync with the remote (ahead and behind). */
export function GitStatus() {
  const repo = useGit((s) => s.repo);
  const busy = useGit((s) => s.busy);
  if (!repo) return null;
  const branch = repo.branch ?? (repo.head ? `${repo.head.slice(0, 8)} (detached)` : 'main');
  const dirty = repo.files.length > 0;
  return (
    <>
      <button
        type="button"
        className={item}
        title={`Branch ${branch}${dirty ? ' (with changes)' : ''}. Click to switch.`}
        onClick={() => void showBranchPicker()}
      >
        <span className="sr-only">Branch </span>
        <GitBranch className="size-3" />
        <span className="max-w-40 truncate">
          {branch}
          {dirty ? '*' : ''}
        </span>
      </button>
      <button
        type="button"
        className={item}
        title={
          repo.upstream
            ? `Sync with ${repo.upstream}: ${repo.behind} to pull, ${repo.ahead} to push`
            : 'Publish this branch'
        }
        aria-label={
          busy || !(repo.upstream && (repo.ahead || repo.behind))
            ? repo.upstream
              ? `Sync: ${repo.behind} behind, ${repo.ahead} ahead`
              : 'Publish branch'
            : undefined
        }
        onClick={() => void syncWithRemote()}
      >
        {busy ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : repo.upstream && (repo.ahead || repo.behind) ? (
          <>
            <span className="sr-only">Sync: </span>
            <ArrowDown className="size-3" />
            <span>{repo.behind}</span>
            <span className="sr-only"> behind, </span>
            <ArrowUp className="size-3" />
            <span>{repo.ahead}</span>
            <span className="sr-only"> ahead</span>
          </>
        ) : (
          <RefreshCw className="size-3" />
        )}
      </button>
    </>
  );
}
