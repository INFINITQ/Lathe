import { beforeEach, describe, expect, it } from 'vitest';
import { type Backend, fakeBackend, setBackend } from '../lib/backend';
import { DebugSession, type SessionHandlers } from './session';
import {
  appendConsole,
  breakpointsIn,
  debugSnapshot,
  debugStateOf,
  moveBreakpoints,
  restoreDebug,
  setBreakpoint,
  toggleBreakpoint,
  updateBreakpoint,
  useDebug,
} from './store';

type Message = {
  seq: number;
  type: string;
  command?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session wired to an adapter written as a function of each message Lathe sends. */
function harness(adapter: (message: Message) => void) {
  const sent: Message[] = [];
  const ran: unknown[] = [];
  const handlers: SessionHandlers = {
    event: () => {},
    runInTerminal: async (_session, args) => {
      ran.push(args.args);
    },
    startDebugging: async () => {},
    closed: () => {},
    log: () => {},
  };
  const base = fakeBackend();
  const backend: Backend = {
    ...base,
    debug: {
      ...base.debug,
      send: async (_id, text) => {
        const message = JSON.parse(text) as Message;
        sent.push(message);
        setTimeout(() => adapter(message), 0);
      },
    },
  };
  setBackend(backend);
  const session = new DebugSession('s1', 'Test', 'fake', { program: 'prog.txt' }, handlers);
  session.attach({ id: 'c1', close: () => {} });
  const deliver = (message: Partial<Message> & { event?: string }) =>
    session.onEvent({ type: 'message', data: JSON.stringify({ seq: 0, ...message }) });
  const reply = (to: { seq: number; command?: string }, body: Record<string, unknown> = {}) =>
    deliver({ type: 'response', request_seq: to.seq, command: to.command, success: true, body });
  return { session, sent, ran, deliver, reply };
}

describe('DebugSession', () => {
  it('starts in the order the adapters expect: launch is answered last', async () => {
    let launch = 0;
    const order: string[] = [];
    const { session, sent, reply, deliver } = harness((message) => {
      if (message.type !== 'request') return;
      if (message.command === 'initialize') {
        reply(message, { supportsConfigurationDoneRequest: true });
        deliver({ type: 'event', event: 'initialized' });
      } else if (message.command === 'launch') {
        launch = message.seq;
      } else if (message.command === 'configurationDone') {
        reply(message);
        reply({ seq: launch, command: 'launch' });
      } else {
        reply(message, { breakpoints: [{ verified: true }] });
      }
    });
    await session.start('launch', async () => {
      order.push('configure');
      await session.request('setBreakpoints', { lines: [3] });
    });
    expect(sent.map((m) => m.command)).toEqual([
      'initialize',
      'launch',
      'setBreakpoints',
      'configurationDone',
    ]);
    expect(order).toEqual(['configure']);
    expect(sent[0]!.arguments).toMatchObject({ adapterID: 'fake', linesStartAt1: true });
    expect(sent[1]!.arguments).toEqual({ program: 'prog.txt' });
  });

  it('fails a launch the adapter refuses before it gets ready', async () => {
    const { session, deliver, reply } = harness((message) => {
      if (message.command === 'initialize') reply(message, {});
      else if (message.command === 'launch') {
        deliver({
          type: 'response',
          request_seq: message.seq,
          command: 'launch',
          success: false,
          message: 'program not found',
        });
      }
    });
    await expect(session.start('launch', async () => {})).rejects.toThrow('program not found');
  });

  it("reports the adapter's own words when a request fails", async () => {
    const { session, deliver } = harness((message) => {
      // CodeLLDB leaves the command empty; js-debug's message is "undefined".
      deliver({
        type: 'response',
        request_seq: message.seq,
        command: '',
        success: false,
        message: 'undefined',
        body: { error: { format: "NameError: name 'x' is not defined" } },
      });
    });
    await expect(session.request('evaluate', { expression: 'x' })).rejects.toThrow(
      "NameError: name 'x' is not defined",
    );
  });

  it('answers runInTerminal, and refuses requests it does not know', async () => {
    const { session, sent, ran, deliver } = harness(() => {});
    deliver({
      seq: 7,
      type: 'request',
      command: 'runInTerminal',
      arguments: { kind: 'integrated', args: ['python', 'app.py'], cwd: 'C:\\p' },
    });
    deliver({ seq: 8, type: 'request', command: 'handshake', arguments: {} });
    await tick();
    expect(ran).toEqual([['python', 'app.py']]);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'response', request_seq: 7, success: true }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'response', request_seq: 8, success: false }),
    );
    expect(session.ended).toBe(false);
  });

  it('fails waiting requests when the connection closes', async () => {
    const { session } = harness(() => {});
    const pending = session.request('threads');
    session.onEvent({ type: 'exit', code: 1 });
    await expect(pending).rejects.toThrow('closed the connection');
    await expect(session.request('threads')).rejects.toThrow('has ended');
  });
});

describe('breakpoints', () => {
  beforeEach(() => useDebug.setState({ breakpoints: [], watches: [], console: [], sessions: [] }));

  it('toggle per line, whatever the path case, and merge when edits join them', () => {
    toggleBreakpoint('C:\\p\\app.py', 3);
    toggleBreakpoint('c:\\P\\APP.py', 5);
    expect(breakpointsIn('C:\\p\\app.py').map((b) => b.line)).toEqual([3, 5]);
    const [first, second] = useDebug.getState().breakpoints;
    moveBreakpoints(
      new Map([
        [first!.id, 4],
        [second!.id, 4],
      ]),
    );
    expect(breakpointsIn('C:\\p\\app.py').map((b) => b.line)).toEqual([4]);
    toggleBreakpoint('C:\\p\\app.py', 4);
    expect(useDebug.getState().breakpoints).toEqual([]);
  });

  it('keep conditions only when they say something', () => {
    const bp = setBreakpoint('C:\\p\\app.py', 2, { condition: '   ', logMessage: 'x is {x}' });
    expect(bp.condition).toBeUndefined();
    updateBreakpoint(bp.id, { condition: 'x > 1' });
    expect(breakpointsIn('C:\\p\\app.py')[0]).toMatchObject({ condition: 'x > 1' });
    updateBreakpoint(bp.id, { condition: '' });
    expect(breakpointsIn('C:\\p\\app.py')[0]).not.toHaveProperty('condition');
  });

  it('are saved without what the adapter said, and restored', () => {
    const bp = setBreakpoint('C:\\p\\app.py', 9);
    updateBreakpoint(bp.id, { verified: false, message: 'no code here' });
    useDebug.setState({ watches: [{ id: 'w', expression: 'x + 1' }] });
    const saved = debugSnapshot();
    expect(saved.breakpoints[0]).not.toHaveProperty('verified');
    useDebug.setState({ breakpoints: [], watches: [] });
    restoreDebug({
      ...saved,
      breakpoints: [...saved.breakpoints, { id: '', path: 'C:\\p\\x.py', line: 0, enabled: true }],
    });
    expect(useDebug.getState().breakpoints.map((b) => b.line)).toEqual([9]);
    expect(useDebug.getState().watches.map((w) => w.expression)).toEqual(['x + 1']);
  });
});

describe('the debug console', () => {
  beforeEach(() => useDebug.setState({ console: [] }));

  it('joins output that arrives in pieces', () => {
    appendConsole({ kind: 'output', category: 'stdout', text: 'hel' });
    appendConsole({ kind: 'output', category: 'stdout', text: 'lo\n' });
    appendConsole({ kind: 'output', category: 'stdout', text: 'next' });
    appendConsole({ kind: 'output', category: 'stderr', text: 'oops' });
    expect(useDebug.getState().console.map((e) => e.text)).toEqual(['hello\n', 'next', 'oops']);
  });
});

describe('debugStateOf', () => {
  it('follows the session you are looking at', () => {
    const session = (id: string, status: 'running' | 'stopped') => ({
      id,
      name: id,
      adapter: 'fake',
      parentId: null,
      status,
      threads: [],
      exceptionFilters: [],
      supports: {
        setVariable: false,
        completions: false,
        conditions: false,
        hitConditions: false,
        logPoints: false,
      },
    });
    const base = useDebug.getState();
    expect(debugStateOf({ ...base, sessions: [] })).toBe('inactive');
    const sessions = [session('a', 'running'), session('b', 'stopped')];
    expect(debugStateOf({ ...base, sessions, focus: null })).toBe('stopped');
    expect(
      debugStateOf({ ...base, sessions, focus: { sessionId: 'a', threadId: 1, frameId: null } }),
    ).toBe('running');
  });
});
