// Every action in Lathe is a command: the palette lists them, keybindings and menus run them,
// and plugins will add their own. A command has an id ("workbench.action.files.save"-style
// names are VS Code's; Lathe uses shorter ones like "file.save").

import { evaluate } from './when';
import { contextSnapshot } from './context';

export interface Command {
  id: string;
  /** Shown in the palette: "Save", "Toggle sidebar"… */
  title: string;
  /** Palette prefix: "File", "View", "Editor"… */
  category?: string;
  run: (...args: never[]) => unknown;
  /** Only available when this clause holds (see services/when.ts). */
  when?: string;
  /** Hidden from the palette (still runnable by id, keybindings and menus). */
  hidden?: boolean;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

/** Adds commands; returns a function that removes them again. */
export function registerCommands(commands: Command[]): () => void {
  for (const command of commands) registry.set(command.id, command);
  listeners.forEach((l) => l());
  return () => {
    for (const command of commands) {
      if (registry.get(command.id) === command) registry.delete(command.id);
    }
    listeners.forEach((l) => l());
  };
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

/** All commands available right now (their `when` holds). */
export function availableCommands(): Command[] {
  const ctx = contextSnapshot();
  return [...registry.values()].filter((c) => evaluate(c.when, ctx));
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function onCommandsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Runs a command by id. Unknown or unavailable commands are ignored (with a warning). */
export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  const command = registry.get(id);
  if (!command) {
    console.warn(`No command "${id}"`);
    return undefined;
  }
  if (!evaluate(command.when, contextSnapshot())) return undefined;
  return (command.run as (...a: unknown[]) => unknown)(...args);
}

/** "File: Save" as shown in the palette. */
export function commandLabel(command: Command): string {
  return command.category ? `${command.category}: ${command.title}` : command.title;
}
