// The Settings editor: every setting with what it does, found by searching or by category, for
// you or for this folder. A change saves at once (to settings.json or the folder's
// .lathe/settings.json). Language sections ("[python]": {...}) and other JSON stay in the file,
// which "settings.json" opens.

import { FileJson, Plus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { type SettingsScope } from '../../lib/backend';
import { usePlugins } from '../../plugins/store';
import { pluginThemes } from '../../plugins/themes';
import { executeCommand } from '../../services/commands';
import {
  DEFAULT_SETTINGS,
  type SettingKey,
  updateAnySetting,
  useSettings,
} from '../../services/settings';
import { CATEGORIES, SETTINGS_SCHEMA, type SettingInfo } from '../../services/settingsSchema';
import { useWorkspace } from '../workspaceStore';

type Control = 'boolean' | 'number' | 'string' | 'list' | 'patterns' | 'json';

interface Entry {
  key: string;
  title: string;
  description: string;
  category: string;
  /** For a plugin's setting: the plugin's name. */
  plugin?: string;
  control: Control;
  defaultValue: unknown;
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

const PLUGINS = 'Plugins';

/** The swatch of each accent (its fill colour). */
const ACCENT_SWATCHES: Record<string, string> = {
  lime: '#d9f99d',
  mint: '#a7f3d0',
  sky: '#bae6fd',
  violet: '#ddd6fe',
  rose: '#fecdd3',
  amber: '#fde68a',
};

function controlFor(value: unknown, key: string): Control {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'list';
  if (key === 'files.exclude' || key === 'search.exclude') return 'patterns';
  return 'json';
}

function builtInEntries(): Entry[] {
  return (Object.entries(SETTINGS_SCHEMA) as [SettingKey, SettingInfo][]).map(([key, info]) => ({
    key,
    ...info,
    control: controlFor(DEFAULT_SETTINGS[key], key),
    defaultValue: DEFAULT_SETTINGS[key],
  }));
}

/** "wordCount.showInStatusBar" → "Show in status bar". */
function titleFromKey(key: string): string {
  const last = key.split('.').at(-1) ?? key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Declared {
  type?: unknown;
  default?: unknown;
  description?: unknown;
  markdownDescription?: unknown;
  enum?: unknown;
  enumDescriptions?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

/** Settings plugins declare (`contributes.settings`), for the plugins that are on. */
function pluginEntries(installed: ReturnType<typeof usePlugins.getState>['installed']): Entry[] {
  const entries: Entry[] = [];
  for (const { manifest, enabled } of installed) {
    if (!enabled) continue;
    const declared = manifest.contributes?.settings;
    if (!declared || typeof declared !== 'object') continue;
    for (const [key, raw] of Object.entries(declared as Record<string, Declared>)) {
      const type = raw.type;
      const fallback =
        type === 'boolean' ? false : type === 'number' || type === 'integer' ? 0 : '';
      const defaultValue =
        raw.default ?? (type === 'array' ? [] : type === 'object' ? {} : fallback);
      const choices = Array.isArray(raw.enum)
        ? raw.enum
            .filter((v): v is string => typeof v === 'string')
            .map((value, i) => {
              const label = Array.isArray(raw.enumDescriptions) ? raw.enumDescriptions[i] : null;
              return { value, label: typeof label === 'string' ? `${value}: ${label}` : value };
            })
        : undefined;
      entries.push({
        key,
        title: titleFromKey(key),
        description: String(raw.description ?? raw.markdownDescription ?? ''),
        category: PLUGINS,
        plugin: manifest.name,
        control: controlFor(defaultValue, key),
        defaultValue,
        choices: choices?.length ? choices : undefined,
        min: typeof raw.minimum === 'number' ? raw.minimum : undefined,
        max: typeof raw.maximum === 'number' ? raw.maximum : undefined,
        step: type === 'integer' ? 1 : undefined,
      });
    }
  }
  return entries;
}

/** A value of the right kind for this setting (what getSetting would accept). */
function usable(entry: Entry, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(entry.defaultValue)) return Array.isArray(value);
  return typeof value === typeof entry.defaultValue;
}

function matches(entry: Entry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    entry.title,
    entry.description,
    entry.key,
    entry.category,
    entry.plugin ?? '',
    ...(entry.choices?.map((c) => c.label) ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const fieldClass =
  'h-7 rounded-md border border-line bg-raised px-2 text-[12.5px] text-text outline-none focus:border-line-strong';

export function SettingsEditor() {
  const root = useWorkspace((s) => s.root);
  const errors = useSettings((s) => s.errors);
  const installed = usePlugins((s) => s.installed);
  const [query, setQuery] = useState('');
  const [chosenScope, setScope] = useState<SettingsScope>('user');
  const scope: SettingsScope = root ? chosenScope : 'user';
  const [current, setCurrent] = useState<string>(CATEGORIES[0]!);
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => [...builtInEntries(), ...pluginEntries(installed)], [installed]);
  const shown = useMemo(() => entries.filter((e) => matches(e, query)), [entries, query]);
  const categories = useMemo(
    () => [...CATEGORIES, ...(entries.some((e) => e.category === PLUGINS) ? [PLUGINS] : [])],
    [entries],
  );
  const groups = categories
    .map((category) => ({ category, entries: shown.filter((e) => e.category === category) }))
    .filter((g) => g.entries.length > 0);

  useLayoutEffect(() => {
    search.current?.focus();
  }, []);

  const jump = (category: string) => {
    setCurrent(category);
    body.current
      ?.querySelector(`[data-category="${category}"]`)
      ?.scrollIntoView({ block: 'start' });
  };

  // The category whose heading was last scrolled past is the current one.
  const onScroll = () => {
    const top = body.current?.getBoundingClientRect().top ?? 0;
    let last = groups[0]?.category;
    for (const section of body.current?.querySelectorAll<HTMLElement>('[data-category]') ?? []) {
      if (section.getBoundingClientRect().top - top <= 24) last = section.dataset.category;
    }
    if (last && last !== current) setCurrent(last);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-editor="settings">
      <header className="shrink-0 border-b border-line px-6 pt-5 pb-3">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-[15px] font-medium text-text">Settings</h1>
          <span className="text-[11.5px] text-text-3" aria-live="polite">
            {query ? `${shown.length} found` : ''}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-[12px] text-text-3 hover:bg-hover hover:text-text"
            onClick={() =>
              void executeCommand(
                scope === 'user'
                  ? 'preferences.openSettingsJson'
                  : 'preferences.openWorkspaceSettings',
              )
            }
          >
            <FileJson className="size-3.5" />
            settings.json
          </button>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={search}
            type="search"
            aria-label="Search settings"
            placeholder="Search settings"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={cn(fieldClass, 'h-8 min-w-0 flex-1 px-2.5')}
          />
          <div
            role="radiogroup"
            aria-label="Whose settings"
            className="flex h-8 shrink-0 items-center rounded-md border border-line p-0.5"
          >
            {(
              [
                ['user', 'Yours'],
                ['workspace', 'This folder'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                disabled={value === 'workspace' && !root}
                title={
                  value === 'workspace'
                    ? root
                      ? 'Settings for this folder only (.lathe/settings.json); they win over yours'
                      : 'Open a folder to give it its own settings'
                    : 'Your settings, for every folder'
                }
                className={cn(
                  'h-full rounded-sm px-2.5 text-[12px] disabled:opacity-40',
                  scope === value ? 'bg-hover text-text' : 'text-text-3 hover:text-text-2',
                )}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {errors.length > 0 && (
          <p className="mt-3 flex items-start gap-1.5 text-[12px] text-warning" role="status">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              A settings file has an error, so its last good values are in use: {errors[0]}
            </span>
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Setting categories"
          className="w-[168px] shrink-0 overflow-y-auto py-3 pl-4"
        >
          {categories.map((category) => {
            const present = groups.some((g) => g.category === category);
            return (
              <button
                key={category}
                type="button"
                disabled={!present}
                aria-current={category === current ? 'true' : undefined}
                className={cn(
                  'block w-full truncate rounded-sm px-2 py-1 text-left text-[12.5px] disabled:text-text-4',
                  category === current && present
                    ? 'text-text shadow-[inset_2px_0_0_var(--accent-fg)]'
                    : 'text-text-3 hover:text-text-2',
                )}
                onClick={() => jump(category)}
              >
                {category}
              </button>
            );
          })}
        </nav>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
          <div className="max-w-[760px] px-6 pt-3 pb-24">
            {groups.map(({ category, entries: list }) => (
              <section
                key={category}
                data-category={category}
                aria-label={category}
                className="pt-3"
              >
                <h2 className="mb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
                  {category}
                </h2>
                {list.map((entry, i) => (
                  <div key={entry.key}>
                    {entry.plugin && entry.plugin !== list[i - 1]?.plugin && (
                      <h3 className="mt-3 text-[12px] font-medium text-text-2">{entry.plugin}</h3>
                    )}
                    <SettingRow entry={entry} scope={scope} />
                  </div>
                ))}
              </section>
            ))}
            {!groups.length && (
              <p className="py-6 text-[12px] text-text-3">No setting matches that search.</p>
            )}
            <p className="mt-8 text-[11.5px] text-text-3">
              Settings for one language, such as <code className="font-mono">{'"[python]"'}</code>,
              go in settings.json.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ entry, scope }: { entry: Entry; scope: SettingsScope }) {
  const id = useId();
  const own = useSettings((s) => (scope === 'user' ? s.user : s.workspace)[entry.key]);
  const yours = useSettings((s) => s.user[entry.key]);
  const folders = useSettings((s) => s.workspace[entry.key]);
  // What you just chose shows at once, while it's being saved.
  const [pending, setPending] = useState<{ value: unknown } | null>(null);
  const mine = pending ? pending.value : own;
  const modified = mine !== undefined;
  const value = usable(entry, mine)
    ? mine
    : scope === 'workspace' && usable(entry, yours)
      ? yours
      : entry.defaultValue;
  const set = (next: unknown) => {
    setPending({ value: next });
    void updateAnySetting(entry.key, next, scope).finally(() => setPending(null));
  };
  const ids = {
    title: `${id}-title`,
    description: `${id}-description`,
    control: `${id}-control`,
  };
  // A setting with one field (a number, text, a list to pick from) has a real <label>.
  const oneField =
    entry.key !== 'workbench.accent' && (entry.control === 'number' || entry.control === 'string');
  const Title = oneField ? 'label' : 'span';

  return (
    <div
      data-setting={entry.key}
      className={cn(
        'group relative -mx-3 rounded-sm px-3 py-2.5',
        modified && 'shadow-[inset_2px_0_0_var(--accent-fg)]',
      )}
    >
      <div className="flex items-baseline gap-2">
        <Title
          id={ids.title}
          htmlFor={oneField ? ids.control : undefined}
          className="text-[12.5px] font-medium text-text"
        >
          {entry.title}
        </Title>
        <span className="truncate font-mono text-[10.5px] text-text-3">{entry.key}</span>
        <span className="flex-1" />
        {modified && (
          <button
            type="button"
            aria-label={`Reset ${entry.title}`}
            title="Reset to the default"
            className="flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-text-3 hover:bg-hover hover:text-text"
            onClick={() => set(undefined)}
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        )}
      </div>
      {scope === 'user' && folders !== undefined && (
        <p className="mt-0.5 text-[11px] text-text-3">This folder sets it too, and wins.</p>
      )}
      {entry.control === 'boolean' ? (
        <label className="mt-1 flex items-start gap-2">
          <input
            type="checkbox"
            checked={value === true}
            aria-labelledby={ids.title}
            aria-describedby={ids.description}
            onChange={(e) => set(e.target.checked)}
            className="mt-0.5 size-3.5 shrink-0 accent-(--accent-fg)"
          />
          <span id={ids.description} className="text-[12px] text-text-2">
            {entry.description}
          </span>
        </label>
      ) : (
        <>
          <p id={ids.description} className="mt-0.5 text-[12px] text-text-2">
            {entry.description}
          </p>
          <div className="mt-1.5">
            <Control entry={entry} value={value} set={set} ids={ids} scope={scope} />
          </div>
        </>
      )}
    </div>
  );
}

interface ControlProps {
  entry: Entry;
  value: unknown;
  set: (value: unknown) => void;
  ids: { title: string; description: string; control: string };
  scope: SettingsScope;
}

function Control({ entry, value, set, ids, scope }: ControlProps): ReactNode {
  // Groups of controls point at the title; a single field is the title's <label> target.
  const labelled = { 'aria-labelledby': ids.title, 'aria-describedby': ids.description };
  const field = { id: ids.control, 'aria-describedby': ids.description };
  if (entry.key === 'workbench.accent') {
    return (
      <div role="radiogroup" {...labelled} className="flex gap-2">
        {(entry.choices ?? []).map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={value === choice.value}
            aria-label={choice.label}
            title={choice.label}
            className={cn(
              'grid size-6 place-items-center rounded-full border',
              value === choice.value
                ? 'border-text-2'
                : 'border-transparent hover:border-line-strong',
            )}
            onClick={() => set(choice.value)}
          >
            <span
              className="size-4 rounded-full"
              style={{ background: ACCENT_SWATCHES[choice.value] ?? choice.value }}
            />
          </button>
        ))}
      </div>
    );
  }
  if (entry.key === 'workbench.colorTheme') {
    const themes = pluginThemes();
    return (
      <select
        {...field}
        className={cn(fieldClass, 'min-w-[240px]')}
        value={String(value)}
        onChange={(e) => set(e.target.value || undefined)}
      >
        <option value="">Mono</option>
        {themes.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label}
          </option>
        ))}
        {value && !themes.some((t) => t.key === value) ? (
          <option value={String(value)}>{String(value)} (not installed)</option>
        ) : null}
      </select>
    );
  }
  if (entry.choices && entry.control === 'string') {
    return (
      <select
        {...field}
        className={cn(fieldClass, 'min-w-[240px]')}
        value={String(value)}
        onChange={(e) => set(e.target.value)}
      >
        {entry.choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  switch (entry.control) {
    case 'number':
      return <NumberField entry={entry} value={value as number} set={set} labelled={field} />;
    case 'string':
      return <TextField value={String(value)} set={set} labelled={field} />;
    case 'list':
      return (
        <ListField
          items={(value as unknown[]).map(String)}
          set={(items) => set(items)}
          labelled={labelled}
          placeholder="Add an item"
        />
      );
    case 'patterns':
      return (
        <PatternsField value={value as Record<string, boolean>} set={set} labelled={labelled} />
      );
    default:
      return (
        <button
          type="button"
          {...labelled}
          className="flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-[12px] text-text-2 hover:bg-hover"
          onClick={() =>
            void executeCommand(
              scope === 'user'
                ? 'preferences.openSettingsJson'
                : 'preferences.openWorkspaceSettings',
            )
          }
        >
          <FileJson className="size-3.5" />
          Edit in settings.json
          <span className="text-text-3">
            ({Object.keys((value as object | null) ?? {}).length} set)
          </span>
        </button>
      );
  }
}

type Labelled = { id?: string; 'aria-labelledby'?: string; 'aria-describedby': string };

/** Saves on Enter or when you leave it; Escape puts the saved value back. */
function useDraft(saved: string, commit: (text: string) => boolean) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  return {
    value: text,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null && draft !== saved && !commit(draft)) return;
      setDraft(null);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (draft !== null && draft !== saved && !commit(draft)) return;
        setDraft(null);
      } else if (e.key === 'Escape' && draft !== null) {
        e.stopPropagation();
        setDraft(null);
      }
    },
  };
}

function NumberField({
  entry,
  value,
  set,
  labelled,
}: {
  entry: Entry;
  value: number;
  set: (v: unknown) => void;
  labelled: Labelled;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const draft = useDraft(String(value), (text) => {
    const n = Number(text);
    if (!text.trim() || !Number.isFinite(n)) {
      setProblem('Type a number.');
      return false;
    }
    if ((entry.min !== undefined && n < entry.min) || (entry.max !== undefined && n > entry.max)) {
      setProblem(`Between ${entry.min ?? '…'} and ${entry.max ?? '…'}.`);
      return false;
    }
    setProblem(null);
    set(n);
    return true;
  });
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        {...labelled}
        aria-invalid={problem ? true : undefined}
        min={entry.min}
        max={entry.max}
        step={entry.step ?? 'any'}
        className={cn(fieldClass, 'w-[120px]', problem && 'border-danger')}
        {...draft}
      />
      {problem && <span className="text-[11.5px] text-danger">{problem}</span>}
    </div>
  );
}

function TextField({
  value,
  set,
  labelled,
}: {
  value: string;
  set: (v: unknown) => void;
  labelled: Labelled;
}) {
  const draft = useDraft(value, (text) => {
    set(text);
    return true;
  });
  return (
    <input
      type="text"
      spellCheck={false}
      {...labelled}
      className={cn(fieldClass, 'w-full max-w-[420px]')}
      {...draft}
    />
  );
}

/** A list of text items: each can be removed, and new ones added. */
function ListField({
  items,
  set,
  labelled,
  placeholder,
}: {
  items: string[];
  set: (items: string[]) => void;
  labelled: Labelled;
  placeholder: string;
}) {
  const [adding, setAdding] = useState('');
  const add = () => {
    const item = adding.trim();
    if (!item) return;
    if (!items.includes(item)) set([...items, item]);
    setAdding('');
  };
  return (
    <div className="max-w-[420px]">
      <ul {...labelled} className="flex flex-col">
        {items.map((item) => (
          <li key={item} className="group/item flex h-7 items-center gap-2 border-b border-line">
            <span className="flex-1 truncate font-mono text-[12px] text-text-2">{item}</span>
            <button
              type="button"
              aria-label={`Remove ${item}`}
              className="grid size-5 place-items-center rounded-sm text-text-3 opacity-0 group-hover/item:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100"
              onClick={() => set(items.filter((i) => i !== item))}
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <input
          type="text"
          spellCheck={false}
          aria-label={placeholder}
          placeholder={placeholder}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          className={cn(fieldClass, 'min-w-0 flex-1 font-mono')}
        />
        <button
          type="button"
          aria-label="Add"
          className="grid size-7 shrink-0 place-items-center rounded-md border border-line text-text-3 hover:bg-hover hover:text-text"
          onClick={add}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Glob patterns, each on or off (`false` keeps a default pattern from applying). */
function PatternsField({
  value,
  set,
  labelled,
}: {
  value: Record<string, boolean>;
  set: (v: unknown) => void;
  labelled: Labelled;
}) {
  const [adding, setAdding] = useState('');
  const add = () => {
    const pattern = adding.trim();
    if (!pattern) return;
    set({ ...value, [pattern]: true });
    setAdding('');
  };
  return (
    <div className="max-w-[420px]">
      <ul {...labelled} className="flex flex-col">
        {Object.entries(value).map(([pattern, on]) => (
          <li key={pattern} className="group/item flex h-7 items-center gap-2 border-b border-line">
            <input
              type="checkbox"
              checked={on}
              aria-label={`Use ${pattern}`}
              onChange={(e) => set({ ...value, [pattern]: e.target.checked })}
              className="size-3.5 shrink-0 accent-(--accent-fg)"
            />
            <span
              className={cn(
                'flex-1 truncate font-mono text-[12px]',
                on ? 'text-text-2' : 'text-text-4 line-through',
              )}
            >
              {pattern}
            </span>
            <button
              type="button"
              aria-label={`Remove ${pattern}`}
              className="grid size-5 place-items-center rounded-sm text-text-3 opacity-0 group-hover/item:opacity-100 hover:bg-hover hover:text-text focus-visible:opacity-100"
              onClick={() => {
                const rest = { ...value };
                delete rest[pattern];
                set(rest);
              }}
            >
              <X className="size-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <input
          type="text"
          spellCheck={false}
          aria-label="Add a pattern"
          placeholder="Add a pattern, such as **/dist"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          className={cn(fieldClass, 'min-w-0 flex-1 font-mono')}
        />
        <button
          type="button"
          aria-label="Add the pattern"
          className="grid size-7 shrink-0 place-items-center rounded-md border border-line text-text-3 hover:bg-hover hover:text-text"
          onClick={add}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
