import {
  Check,
  ChevronRight,
  Ellipsis,
  FileText,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from 'react';
import type { GitFileStatus } from '../../lib/backend';
import { cn } from '../../lib/cn';
import { basename, dirname, relative } from '../../lib/paths';
import {
  type GitGroup,
  commit,
  discard,
  groupsOf,
  initRepository,
  letterOf,
  refreshGit,
  remote,
  showGitOutput,
  stage,
  stash,
  unstage,
  useGit,
} from '../../services/git';
import { DropdownMenuButton } from '../../ui/Menu';
import { openPath } from '../editors/store';
import { fileIcon } from '../fileIcons';
import { useWorkspace } from '../workspaceStore';
import { createBranch, openChange, pickBranchToDelete, showBranchPicker } from './actions';

const GROUPS: { id: GitGroup; title: string }[] = [
  { id: 'conflicts', title: 'Merge changes' },
  { id: 'staged', title: 'Staged changes' },
  { id: 'changes', title: 'Changes' },
];

/** Colours for the status letters. */
const LETTER_CLASS: Record<string, string> = {
  M: 'text-warning',
  A: 'text-accent-fg',
  U: 'text-accent-fg',
  D: 'text-danger',
  R: 'text-info',
  C: 'text-info',
  T: 'text-warning',
  '!': 'text-danger',
};

const iconButton =
  'grid size-6 place-items-center rounded-sm text-text-3 hover:bg-hover hover:text-text [&>svg]:size-3.5';

function IconButton({
  label,
  onClick,
  children,
  mouseOnly,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  /** A row's hover action: the keyboard has the row's own keys for it (Enter, Space, Delete). */
  mouseOnly?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={mouseOnly ? undefined : label}
      aria-hidden={mouseOnly || undefined}
      tabIndex={mouseOnly ? -1 : undefined}
      title={label}
      className={iconButton}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  );
}

/** Source control (Ctrl+Shift+G): what changed, staging, committing and branches. */
export function ScmView() {
  const root = useWorkspace((s) => s.root);
  const { repo, loading, busy, message, amend } = useGit();
  useEffect(() => {
    void refreshGit();
  }, [root]);

  const header = (
    <header className="group/header flex h-(--tabs-h) shrink-0 items-center gap-1 pr-2 pl-3">
      <h2 className="flex-1 truncate text-[11px] font-medium tracking-wide text-text-3 uppercase">
        Source control
      </h2>
      {repo && (
        <>
          <IconButton label="Refresh" onClick={() => void refreshGit()}>
            <RefreshCw />
          </IconButton>
          <DropdownMenuButton
            align="end"
            trigger={
              <button
                type="button"
                aria-label="More Git actions"
                title="More Git actions"
                className={iconButton}
              >
                <Ellipsis />
              </button>
            }
            entries={[
              { label: 'Commit', run: () => void commit() },
              { label: 'Commit (amend the last commit)', run: () => void commit({ amend: true }) },
              'separator',
              { label: 'Pull', run: () => void remote('pull') },
              { label: 'Push', run: () => void remote('push') },
              { label: 'Fetch', run: () => void remote('fetch') },
              { label: 'Sync (pull, then push)', run: () => void remote('sync') },
              'separator',
              { label: 'Switch branch…', run: () => void showBranchPicker() },
              { label: 'Create branch…', run: () => void createBranch() },
              { label: 'Delete branch…', run: () => void pickBranchToDelete() },
              'separator',
              { label: 'Stash changes', run: () => void stash('push') },
              { label: 'Apply and drop the last stash', run: () => void stash('pop') },
              'separator',
              { label: 'Show Git output', run: () => void showGitOutput() },
            ]}
          />
        </>
      )}
    </header>
  );

  if (!root) {
    return (
      <div className="flex h-full flex-col" data-view="scm">
        {header}
        <p className="px-3 text-[12px] text-text-3">Open a folder to use source control.</p>
      </div>
    );
  }
  if (!repo) {
    return (
      <div className="flex h-full flex-col" data-view="scm">
        {header}
        <div className="space-y-3 px-3 text-[12px] text-text-3">
          {loading ? (
            <p>Reading the repository…</p>
          ) : (
            <>
              <p>This folder isn't in a Git repository.</p>
              <button
                type="button"
                data-autofocus
                onClick={() => void initRepository()}
                className="flex h-7 w-full items-center justify-center gap-2 rounded-md bg-accent text-[12px] font-medium text-accent-ink hover:brightness-95"
              >
                <GitBranch className="size-3.5" />
                Initialize repository
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const grouped = new Map<GitGroup, GitFileStatus[]>(GROUPS.map((g) => [g.id, []]));
  for (const file of repo.files) for (const group of groupsOf(file)) grouped.get(group)!.push(file);
  const staged = grouped.get('staged')!.length;
  const changes = grouped.get('changes')!.length;
  const branch = repo.branch ?? (repo.head ? repo.head.slice(0, 8) : 'main');

  return (
    <div className="flex h-full min-h-0 flex-col" data-view="scm">
      {header}
      <div className="shrink-0 space-y-1.5 px-2 pb-2">
        <textarea
          aria-label="Commit message"
          data-autofocus
          placeholder={`Message (Ctrl+Enter to commit on ${branch})`}
          value={message}
          rows={Math.min(8, Math.max(2, message.split('\n').length))}
          spellCheck
          onChange={(e) => useGit.setState({ message: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) {
              e.preventDefault();
              void commit();
            }
          }}
          className="block w-full resize-none rounded-md border border-line-strong bg-raised px-2 py-1.5 text-[12.5px] text-text outline-none placeholder:text-text-4 focus:border-accent-fg"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void commit()}
            className="flex h-7 flex-1 items-center justify-center gap-2 rounded-md bg-accent text-[12px] font-medium text-accent-ink hover:brightness-95 disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            {busy ??
              (amend ? 'Amend the last commit' : staged ? `Commit ${staged} staged` : 'Commit')}
          </button>
          <label
            className="flex items-center gap-1 text-[11px] text-text-3"
            title="Change the last commit instead of making a new one"
          >
            <input
              type="checkbox"
              checked={amend}
              onChange={(e) => useGit.setState({ amend: e.target.checked })}
              className="accent-[var(--accent-fg)]"
            />
            Amend
          </label>
        </div>
      </div>
      {repo.files.length ? (
        <div
          className="min-h-0 flex-1 overflow-y-auto pb-4"
          role="tree"
          aria-label="Changes"
          onKeyDown={onTreeKey}
        >
          {GROUPS.map(({ id, title }) => {
            const files = grouped.get(id)!;
            if (!files.length) return null;
            const first = GROUPS.find((g) => grouped.get(g.id)!.length)?.id === id;
            return (
              <Group
                key={id}
                group={id}
                title={title}
                files={files}
                root={repo.root}
                first={first}
              />
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-1 text-[12px] text-text-3">No changes.</p>
      )}
      {changes + staged > 0 && (
        <span className="sr-only">{`${changes} changed, ${staged} staged`}</span>
      )}
    </div>
  );
}

/** Arrow keys, Home and End move between the tree's items (headings and files). */
function onTreeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown'
      ? Math.min(items.length - 1, at + 1)
      : event.key === 'ArrowUp'
        ? Math.max(0, at - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : null;
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
}

const treeItem =
  'outline-none focus-visible:bg-hover focus-visible:shadow-[inset_2px_0_0_var(--accent-fg)]';

function Group({
  group,
  title,
  files,
  root,
  first,
}: {
  group: GitGroup;
  title: string;
  files: GitFileStatus[];
  root: string;
  /** The first heading is where Tab enters the tree. */
  first: boolean;
}) {
  const [open, setOpen] = useState(true);
  const paths = files.map((f) => f.path);
  const id = useId();
  // The heading is a tree item of its own; its files are a group beside it (a group may only
  // hold tree items, and the heading has buttons).
  return (
    <>
      <div className="group relative">
        <div
          role="treeitem"
          aria-level={1}
          aria-expanded={open}
          aria-selected={false}
          aria-labelledby={`${id}-title ${id}-count`}
          tabIndex={first ? 0 : -1}
          className={cn(
            'flex h-[22px] cursor-default items-center gap-1 pr-2 pl-1 text-[11px] font-medium tracking-wide text-text-3 uppercase group-hover:bg-hover',
            treeItem,
          )}
          onClick={() => setOpen(!open)}
          onKeyDown={(e) => {
            const toggle =
              e.key === 'Enter' ||
              (e.key === 'ArrowRight' && !open) ||
              (e.key === 'ArrowLeft' && open);
            if (toggle) setOpen(!open);
            else if (e.key === ' ') void (group === 'staged' ? unstage(paths) : stage(paths));
            else if (e.key === 'Delete' && group === 'changes') void discard(files);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform duration-(--dur)', open && 'rotate-90')}
          />
          <span id={`${id}-title`} className="flex-1 truncate">
            {title}
          </span>{' '}
          <span
            id={`${id}-count`}
            className="ml-1 rounded-full bg-raised px-1.5 text-[10.5px] text-text-2 group-hover:invisible"
          >
            {files.length}
          </span>
        </div>
        <span
          aria-hidden="true"
          className="absolute top-0 right-2 flex h-[22px] items-center gap-0.5 opacity-0 group-hover:opacity-100"
        >
          {group === 'staged' && (
            <IconButton mouseOnly label="Unstage all" onClick={() => void unstage(paths)}>
              <Minus />
            </IconButton>
          )}
          {group !== 'staged' && (
            <>
              {group === 'changes' && (
                <IconButton
                  mouseOnly
                  label="Discard all changes"
                  onClick={() => void discard(files)}
                >
                  <Undo2 />
                </IconButton>
              )}
              <IconButton mouseOnly label="Stage all" onClick={() => void stage(paths)}>
                <Plus />
              </IconButton>
            </>
          )}
        </span>
      </div>
      {open && (
        <div role="group" aria-label={title}>
          {files.map((file) => (
            <Row key={`${group}:${file.path}`} file={file} group={group} root={root} />
          ))}
        </div>
      )}
    </>
  );
}

function Row({ file, group, root }: { file: GitFileStatus; group: GitGroup; root: string }) {
  const name = basename(file.path);
  const folder = relative(root, dirname(file.path));
  const letter = letterOf(file, group);
  const Icon = fileIcon(name);
  const shownFolder = folder === '.' ? '' : folder;
  return (
    <div className="group relative">
      <div
        role="treeitem"
        aria-level={2}
        aria-selected={false}
        // The name reads as the row does: file, folder, status letter.
        aria-label={[name, shownFolder, letter].filter(Boolean).join(' ')}
        aria-keyshortcuts={group === 'changes' ? 'Enter Space Delete' : 'Enter Space'}
        tabIndex={-1}
        title={file.path}
        className={cn(
          'flex h-[22px] cursor-default items-center gap-1.5 pr-2 pl-7 text-[12.5px] whitespace-nowrap text-text-2 group-hover:bg-hover group-hover:text-text',
          treeItem,
        )}
        onClick={() => openChange(file, group)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openChange(file, group);
          else if (e.key === ' ') {
            void (group === 'staged' ? unstage([file.path]) : stage([file.path]));
          } else if (e.key === 'Delete' && group === 'changes') void discard([file]);
          else if (e.key === 'ArrowLeft') {
            // Up to the group's heading (the tree item just before the group).
            e.currentTarget
              .closest('[role="group"]')
              ?.previousElementSibling?.querySelector<HTMLElement>('[role="treeitem"]')
              ?.focus();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDoubleClick={() => void openPath(file.path)}
      >
        <Icon className="size-3.5 shrink-0 text-text-3" strokeWidth={1.75} />
        {/* The spaces keep the parts apart in the text screen readers get (flex hides them). */}
        <span className={cn('shrink-0', letter === 'D' && 'line-through')}>{name}</span>{' '}
        <span className="min-w-0 truncate text-[11px] text-text-3">{shownFolder}</span>{' '}
        <span className="flex-1" />
        <span
          className={cn(
            'w-3 text-center font-mono text-[11px]',
            LETTER_CLASS[letter] ?? 'text-text-3',
          )}
        >
          {letter}
        </span>
      </div>
      <span
        aria-hidden="true"
        className="absolute top-0 right-[26px] flex h-[22px] items-center gap-0.5 opacity-0 group-hover:opacity-100"
      >
        {letter !== 'D' && (
          <IconButton mouseOnly label={`Open ${name}`} onClick={() => void openPath(file.path)}>
            <FileText />
          </IconButton>
        )}
        {group === 'changes' && (
          <IconButton
            mouseOnly
            label={`Discard changes in ${name}`}
            onClick={() => void discard([file])}
          >
            <Undo2 />
          </IconButton>
        )}
        {group === 'staged' ? (
          <IconButton mouseOnly label={`Unstage ${name}`} onClick={() => void unstage([file.path])}>
            <Minus />
          </IconButton>
        ) : (
          <IconButton mouseOnly label={`Stage ${name}`} onClick={() => void stage([file.path])}>
            <Plus />
          </IconButton>
        )}
      </span>
    </div>
  );
}
