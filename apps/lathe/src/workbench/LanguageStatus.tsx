import { Braces, CircleAlert, LoaderCircle } from 'lucide-react';
import { useEditorStatus } from '../editor/active';
import { cn } from '../lib/cn';
import {
  activeServer,
  restartActiveServer,
  showActiveServerOutput,
  stopActiveServer,
} from '../lsp/manager';
import { type ServerState, useLanguageServers } from '../lsp/server';
import { quickPick } from './quickinput/store';

const STATES: Record<ServerState, string> = {
  starting: 'starting',
  running: 'ready',
  restarting: 'restarting',
  stopped: 'stopped',
  failed: 'not working',
};

async function serverMenu() {
  const server = activeServer();
  if (!server) return;
  const picked = await quickPick(
    [
      { id: 'restart', label: `Restart ${server.def.name}` },
      { id: 'output', label: 'Show its output' },
      { id: 'stop', label: `Stop ${server.def.name}` },
    ],
    { placeholder: `${server.def.name}: ${STATES[server.state]}` },
  );
  if (picked?.id === 'restart') void restartActiveServer();
  else if (picked?.id === 'output') showActiveServerOutput();
  else if (picked?.id === 'stop') void stopActiveServer();
}

/** The status bar's language server item: which server serves this file, and how it's doing. */
export function LanguageStatus() {
  useEditorStatus((s) => s.docId);
  const servers = useLanguageServers((s) => s.servers);
  const server = activeServer();
  const info = server ? servers[server.key] : undefined;
  if (!info) return null;
  const busy = info.state === 'starting' || info.state === 'restarting' || !!info.progress;
  const broken = info.state === 'failed' || info.state === 'stopped';
  const text =
    info.progress ?? (info.state === 'running' ? info.name : `${info.name}: ${STATES[info.state]}`);
  return (
    <button
      type="button"
      title={`${info.name} (${STATES[info.state]})${info.error ? `: ${info.error}` : ''}. Click for options.`}
      // Its name holds what it shows, so voice control can find it by that.
      aria-label={`Language server ${text}${
        text === info.name ? `: ${STATES[info.state]}` : ` (${info.name}: ${STATES[info.state]})`
      }`}
      onClick={() => void serverMenu()}
      className={cn(
        'flex h-full max-w-64 items-center gap-1 px-1.5 text-text-3 transition-colors duration-(--dur) hover:bg-hover hover:text-text',
        broken && 'text-warning',
      )}
    >
      {busy ? (
        <LoaderCircle className="size-3 shrink-0 animate-spin" />
      ) : broken ? (
        <CircleAlert className="size-3 shrink-0" />
      ) : (
        <Braces className="size-3 shrink-0" />
      )}
      <span className="truncate">{text}</span>
    </button>
  );
}
