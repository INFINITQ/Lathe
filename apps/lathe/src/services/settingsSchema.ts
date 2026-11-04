// What the Settings editor shows for each setting: a title, a description, where it belongs, and
// the choices for one that has a few. `satisfies` keeps it in step with DEFAULT_SETTINGS: a new
// setting doesn't compile until it's described here.

import type { SettingKey } from './settings';

export type SettingCategory =
  | 'Appearance'
  | 'Editor'
  | 'Files'
  | 'Explorer'
  | 'Search'
  | 'Source control'
  | 'Language servers'
  | 'Debugging'
  | 'Window';

export interface SettingInfo {
  title: string;
  description: string;
  category: SettingCategory;
  /** For a setting with a few values: each value and how to show it. */
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
}

export const SETTINGS_SCHEMA = {
  'workbench.theme': {
    title: 'Theme',
    description: 'Light, dark, or whichever Windows uses.',
    category: 'Appearance',
    choices: [
      { value: 'system', label: 'Follow Windows' },
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ],
  },
  'workbench.accent': {
    title: 'Accent colour',
    description: 'The one colour Mono uses for what matters: the cursor line, buttons, focus.',
    category: 'Appearance',
    choices: [
      { value: 'lime', label: 'Lime' },
      { value: 'mint', label: 'Mint' },
      { value: 'sky', label: 'Sky' },
      { value: 'violet', label: 'Violet' },
      { value: 'rose', label: 'Rose' },
      { value: 'amber', label: 'Amber' },
    ],
  },
  'workbench.colorTheme': {
    title: 'Colour theme',
    description: 'A colour theme from a plugin ("<plugin id>:<name>"); empty for Mono.',
    category: 'Appearance',
  },
  'workbench.activityBar.visible': {
    title: 'Activity bar',
    description: 'Show the bar of view icons on the left.',
    category: 'Appearance',
  },
  'workbench.statusBar.visible': {
    title: 'Status bar',
    description: 'Show the status bar at the bottom.',
    category: 'Appearance',
  },
  'workbench.editor.showTabs': {
    title: 'Tabs',
    description: 'Show open editors as tabs.',
    category: 'Appearance',
  },
  'workbench.editor.enablePreview': {
    title: 'Preview tabs',
    description:
      'A file opened with one click shows in a preview tab, which the next one replaces until you edit it.',
    category: 'Window',
  },
  'workbench.startupEditor': {
    title: 'On start',
    description: 'What shows when no editor comes back from last time.',
    category: 'Window',
    choices: [
      { value: 'welcome', label: 'The Welcome page' },
      { value: 'none', label: 'Nothing' },
    ],
  },
  'window.restoreFolder': {
    title: 'Reopen the last folder',
    description: 'Open the folder (and its editors) you had open when Lathe last closed.',
    category: 'Window',
  },
  'editor.fontFamily': {
    title: 'Font',
    description: 'A font for code, such as Cascadia Code. Empty for JetBrains Mono.',
    category: 'Editor',
  },
  'editor.fontSize': {
    title: 'Font size',
    description: 'In pixels.',
    category: 'Editor',
    min: 8,
    max: 40,
    step: 1,
  },
  'editor.lineHeight': {
    title: 'Line height',
    description: 'As a multiple of the font size.',
    category: 'Editor',
    min: 1,
    max: 3,
    step: 0.05,
  },
  'editor.fontLigatures': {
    title: 'Ligatures',
    description: 'Join characters such as => and != when the font has ligatures.',
    category: 'Editor',
  },
  'editor.tabSize': {
    title: 'Tab size',
    description: 'How many spaces a tab is.',
    category: 'Editor',
    min: 1,
    max: 16,
    step: 1,
  },
  'editor.insertSpaces': {
    title: 'Indent with spaces',
    description: 'Tab inserts spaces instead of a tab character.',
    category: 'Editor',
  },
  'editor.detectIndentation': {
    title: 'Detect indentation',
    description: 'Follow the indentation a file already uses.',
    category: 'Editor',
  },
  'editor.wordWrap': {
    title: 'Word wrap',
    description: 'Wrap long lines at the edge of the editor.',
    category: 'Editor',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
  },
  'editor.lineNumbers': {
    title: 'Line numbers',
    description: 'Show line numbers, or how far each line is from the cursor.',
    category: 'Editor',
    choices: [
      { value: 'on', label: 'On' },
      { value: 'relative', label: 'Relative' },
      { value: 'off', label: 'Off' },
    ],
  },
  'editor.minimap.enabled': {
    title: 'Minimap',
    description: 'Show an overview of the file beside the editor.',
    category: 'Editor',
  },
  'editor.renderWhitespace': {
    title: 'Show whitespace',
    description: 'Show spaces and tabs as faint dots and arrows.',
    category: 'Editor',
    choices: [
      { value: 'none', label: 'No' },
      { value: 'trailing', label: 'At the ends of lines' },
      { value: 'all', label: 'Everywhere' },
    ],
  },
  'editor.renderLineHighlight': {
    title: 'Highlight the cursor line',
    description: 'Tint the line the cursor is on.',
    category: 'Editor',
  },
  'editor.cursorBlinking': {
    title: 'Blinking cursor',
    description: 'Blink the cursor.',
    category: 'Editor',
  },
  'editor.guides.indentation': {
    title: 'Indent guides',
    description: 'Draw faint lines at each indentation level.',
    category: 'Editor',
  },
  'editor.matchBrackets': {
    title: 'Matching brackets',
    description: 'Highlight the bracket that matches the one at the cursor.',
    category: 'Editor',
  },
  'editor.autoClosingBrackets': {
    title: 'Close brackets',
    description: 'Type the closing bracket or quote for you.',
    category: 'Editor',
  },
  'editor.folding': {
    title: 'Folding',
    description: 'Fold blocks of code from the gutter.',
    category: 'Editor',
  },
  'editor.scrollBeyondLastLine': {
    title: 'Scroll past the end',
    description: 'Let the last line scroll up to the top.',
    category: 'Editor',
  },
  'editor.formatOnSave': {
    title: 'Format on save',
    description: 'Format the file with its language server when you save.',
    category: 'Editor',
  },
  'editor.formatOnSaveTimeout': {
    title: 'Format on save: time limit',
    description: 'Milliseconds to wait for the language server before saving without formatting.',
    category: 'Editor',
    min: 100,
    max: 20000,
    step: 100,
  },
  'editor.largeFileOptimizations': {
    title: 'Large files',
    description:
      'For files over 2 MB or 50,000 lines, leave out the minimap, sticky scroll, guides, folding, Git bars, blame and the language server, so they open and scroll quickly.',
    category: 'Editor',
  },
  'editor.emmet': {
    title: 'Emmet',
    description: 'Expand abbreviations such as ul>li*3 with Tab in HTML, CSS and JSX.',
    category: 'Editor',
  },
  'editor.vim': {
    title: 'Vim mode',
    description:
      "Vim's modes and keys in the editor (Escape for normal mode, i to insert, :w to save).",
    category: 'Editor',
  },
  'editor.stickyScroll.enabled': {
    title: 'Sticky scroll',
    description: 'Keep the lines of the functions and classes you are in at the top.',
    category: 'Editor',
  },
  'editor.inlayHints.enabled': {
    title: 'Inlay hints',
    description: 'Show parameter names and types from the language server inside the code.',
    category: 'Editor',
  },
  'breadcrumbs.symbolPath': {
    title: 'Symbols in breadcrumbs',
    description: 'Show the function or class around the cursor after the file path.',
    category: 'Editor',
  },
  'files.autoSave': {
    title: 'Auto save',
    description: 'Save by itself: after a pause in typing, or when you switch away.',
    category: 'Files',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'afterDelay', label: 'After a pause' },
      { value: 'onFocusChange', label: 'When the editor loses focus' },
    ],
  },
  'files.autoSaveDelay': {
    title: 'Auto save: pause',
    description: 'Milliseconds of no typing before saving, with "After a pause".',
    category: 'Files',
    min: 100,
    max: 60000,
    step: 100,
  },
  'files.trimTrailingWhitespace': {
    title: 'Trim trailing whitespace',
    description: 'Remove spaces at the ends of lines when saving.',
    category: 'Files',
  },
  'files.insertFinalNewline': {
    title: 'Final newline',
    description: 'End files with a newline when saving.',
    category: 'Files',
  },
  'files.hotExit': {
    title: 'Keep unsaved changes',
    description: 'Close without asking about unsaved files; they come back, still unsaved.',
    category: 'Files',
  },
  'files.exclude': {
    title: 'Hidden files',
    description: 'Glob patterns for files and folders the Explorer and Ctrl+P leave out.',
    category: 'Files',
  },
  'explorer.confirmDelete': {
    title: 'Confirm deletes',
    description: 'Ask before moving files to the Recycle Bin.',
    category: 'Explorer',
  },
  'explorer.confirmDragAndDrop': {
    title: 'Confirm moves',
    description: 'Ask before moving files by dragging them.',
    category: 'Explorer',
  },
  'explorer.autoReveal': {
    title: 'Reveal the active file',
    description: 'Select the file of the active editor in the Explorer.',
    category: 'Explorer',
  },
  'search.exclude': {
    title: 'Left out of search',
    description: 'Glob patterns for files and folders Search leaves out.',
    category: 'Search',
  },
  'search.useIgnoreFiles': {
    title: 'Use .gitignore',
    description: 'Leave out what .gitignore and .ignore files list.',
    category: 'Search',
  },
  'search.searchOnType': {
    title: 'Search as you type',
    description: 'Start searching while you type instead of waiting for Enter.',
    category: 'Search',
  },
  'search.searchOnTypeDebouncePeriod': {
    title: 'Search as you type: pause',
    description: 'Milliseconds after the last key before searching.',
    category: 'Search',
    min: 0,
    max: 5000,
    step: 50,
  },
  'search.maxResults': {
    title: 'Most results',
    description: 'Stop after this many matches.',
    category: 'Search',
    min: 100,
    max: 1_000_000,
    step: 100,
  },
  'git.blame.inline': {
    title: 'Line blame',
    description: 'Show who last changed the cursor line, and when, at its end.',
    category: 'Source control',
  },
  'lsp.enabled': {
    title: 'Language servers',
    description: 'Use language servers for completions, errors, go to definition and renames.',
    category: 'Language servers',
  },
  'lsp.trace': {
    title: 'Log messages',
    description: 'Write every message to and from a server into its Output channel.',
    category: 'Language servers',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 'messages', label: 'Every message' },
    ],
  },
  'lsp.disabled': {
    title: 'Turned-off servers',
    description: 'Built-in servers not to use, by id ("basedpyright", "clangd"…).',
    category: 'Language servers',
  },
  'lsp.servers': {
    title: 'Your own servers',
    description: '{ "id": { "command": [program, ...args], "languages": [...] } }',
    category: 'Language servers',
  },
  'lsp.declined': {
    title: 'Not offered again',
    description: 'Servers Lathe offered to install and you said no to.',
    category: 'Language servers',
  },
  'debug.adapters': {
    title: 'Your own debug adapters',
    description: '{ "type": { "command": [program, ...args], "languages": [...] } }',
    category: 'Debugging',
  },
  'debug.openDebugConsole': {
    title: 'Open the Debug console',
    description: 'When the Debug console opens by itself (programs in a terminal never open it).',
    category: 'Debugging',
    choices: [
      { value: 'openOnFirstSessionStart', label: 'For the first session' },
      { value: 'openOnSessionStart', label: 'For every session' },
      { value: 'neverOpen', label: 'Never' },
    ],
  },
  'debug.focusEditorOnBreak': {
    title: 'Come forward on a breakpoint',
    description: 'Show the editor (and the window) when the program stops.',
    category: 'Debugging',
  },
} satisfies Record<SettingKey, SettingInfo>;

export const CATEGORIES: SettingCategory[] = [
  'Appearance',
  'Editor',
  'Files',
  'Explorer',
  'Search',
  'Source control',
  'Language servers',
  'Debugging',
  'Window',
];
