# Writing Lathe plugins

A plugin is a folder with a `lathe-plugin.json` manifest. It can declare things (commands,
keys, colour themes, snippets, language servers, settings) and, if it names a `main` module, run
code. Two samples live in [`plugins/`](../plugins): **Word count** (code: a command and a status
bar item) and **Sunset** (no code: a colour theme and Python snippets).

To try one, open **Plugins** (Ctrl+Shift+X), choose **Install a plugin → Install from a
folder…**, and pick its folder. Lathe shows what the plugin is and what it asks to do before it
installs anything.

## The manifest

```json
{
  "id": "you.word-count",
  "name": "Word count",
  "version": "1.0.0",
  "publisher": "You",
  "description": "Counts words.",
  "engines": { "lathe": ">=0.1.0" },
  "main": "main.js",
  "activationEvents": ["onStartup"],
  "contributes": {
    "commands": [{ "command": "wordCount.count", "title": "Count words" }],
    "keybindings": [{ "key": "ctrl+alt+w", "command": "wordCount.count" }]
  },
  "permissions": []
}
```

| Field              | Meaning                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `publisher.name`, in lower-case letters, digits and dashes. Installing a plugin with the same id replaces it.                                                                   |
| `version`          | `major.minor.patch`.                                                                                                                                                            |
| `engines.lathe`    | The Lathe versions it works with: `*`, `>=0.1.0` or `^0.1.0`.                                                                                                                   |
| `main`             | The ES module to run, relative to the folder. Leave it out for a plugin that only declares things.                                                                              |
| `activationEvents` | When the code starts: `onStartup` (or nothing), `onCommand:<id>` (the first time one of its commands runs), `onLanguage:<id>` (when an editor of that language becomes active). |
| `permissions`      | What it may do beyond its sandbox (below).                                                                                                                                      |

## Contributions

- **`commands`**: `{ "command", "title", "category" }`. They appear in the palette at once; the
  plugin's code handles them with `lathe.commands.register`.
- **`keybindings`**: `{ "key", "command", "when" }`, in VS Code's format. Your own keybindings
  win over a plugin's, and a plugin's over Lathe's own.
- **`themes`**: `{ "label", "uiTheme": "vs-dark" | "vs", "path" }`, pointing at a VS Code colour
  theme (JSON with comments). Its workbench colours map onto Lathe's design tokens and its token
  colours onto the syntax colours. Pick it with **Preferences: Colour theme…**.
- **`snippets`**: `{ "language", "path" }`, pointing at a VS Code snippets file. `$1`, `${1:text}`,
  `$0`, choices and the common variables (`$TM_FILENAME`, `$CURRENT_YEAR`…) work.
- **`languageServers`**: `{ "<id>": { "name", "command": [program, ...args], "languages": [...] } }`.
  Like servers in your settings, they start only in folders you've trusted.
- **`settings`**: `{ "<key>": { "type", "default", "description" } }` (`enum` and
  `enumDescriptions` give a list to pick from; `minimum` and `maximum` bound a number). They show
  in the Settings editor under Plugins. Read them with `lathe.settings.get`.

## Code

The module's `activate(lathe)` runs when the plugin starts. Everything Lathe offers is on
`lathe`; the types are in [`packages/plugin-api/index.d.ts`](../packages/plugin-api/index.d.ts).

```js
export function activate(lathe) {
  const item = lathe.window.createStatusBarItem({ alignment: 'right' });
  lathe.editor.onDidChange((editor) => {
    item.text = editor ? `${editor.text.split(/\s+/).filter(Boolean).length} words` : '';
    editor ? item.show() : item.hide();
  });
  lathe.commands.register('wordCount.count', async () => {
    const editor = await lathe.editor.active();
    await lathe.window.showInformation(editor ? `${editor.text.length} characters` : 'No file.');
  });
}
```

- **`commands`**: `register(id, run)`, and `execute(id, ...args)` for any command, Lathe's own
  included.
- **`window`**: notifications (with actions), a quick pick, an input box, status bar items.
- **`editor`**: the active editor's path, language, text and selection; `onDidChange`; `insert`
  and `replaceSelection`.
- **`workspace`**: `root()`, `readFile`, `writeFile`, `findFiles`, inside the open folder only.
- **`languages`**: completion and hover providers for a language (or `*`). Answer within a second
  or two; slower answers are skipped.
- **`terminal`**: `run(command)` in a terminal you can see.
- **`settings`**: `get(key)`.

`console.log` and friends go to the plugin's channel in the Output panel.

## The sandbox and permissions

Each plugin's code runs in its own Worker, inside a hidden frame on a separate origin
(`http://lathe-plugin.localhost`). It can't touch Lathe's page, call Lathe's commands directly,
or read your files. It reaches Lathe only through `lathe`, and Lathe checks each call:

| Permission        | Allows                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `workspace.read`  | `workspace.readFile`, `workspace.findFiles`                                                                 |
| `workspace.write` | `workspace.writeFile`                                                                                       |
| `terminal`        | `terminal.run`                                                                                              |
| `network`         | `fetch` and WebSockets to https addresses (otherwise its content security policy blocks all network access) |

Plugins share that one origin with each other, so they can't hide from one another; install
plugins you trust.

A plugin can't freeze the editor: a command that doesn't answer within 10 seconds is reported
("isn't responding") with a button to restart it, and a plugin whose Worker crashes is restarted
(up to three times in five minutes).

## Installing

- **From a folder**: the folder with `lathe-plugin.json`.
- **From a .zip**: the plugin's folder zipped (at the top, or inside one folder).
- **From a Git URL**: an `https://` repository; Lathe clones its newest commit.

Installed plugins live in `%LOCALAPPDATA%\app.lathe\plugins\<id>`. Turning one off keeps it
installed; removing it deletes that folder.
