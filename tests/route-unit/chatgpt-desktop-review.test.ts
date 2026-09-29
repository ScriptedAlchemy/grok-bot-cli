import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, rstest } from '@rstest/core';
import { CdpSession } from '../../src/core/chatgpt-desktop/cdp-session.js';
import { CdpChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/cdp-adapter.js';
import { ChatGptDesktopFacade, finalizeThreadList, setChatGptDesktopAdapterForTests } from '../../src/core/chatgpt-desktop/facade.js';
import { CONVERSATION_ID_EXPRESSION, REPLY_STATE_EXPRESSION, LOADING_TASK_GONE_EXPRESSION, waitForReplyDone } from '../../src/core/chatgpt-desktop/cdp-dom.js';
import { sendSchema, waitSchema } from '../../src/core/codex/routes.js';
import { statusOperation } from '../../src/core/chatgpt-desktop/routes.js';
import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';

const row = (threadId: string) => ({ threadId, title: threadId, pinned: false, selected: false, kind: 'codex' });
afterEach(() => { rstest.restoreAllMocks(); setChatGptDesktopAdapterForTests(null); });

it('rejects CDP HTTP redirects without contacting their destination', async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/escaped') { redirected++; res.end('{}'); }
    else { res.writeHead(302, { location: '/escaped' }); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    await expect(CdpSession.fetchVersion(port)).rejects.toThrow();
    await expect(CdpSession.fetchJsonList(port)).rejects.toThrow();
    expect(redirected).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('normalizes only thread IDs, preserving correlation, message and turn IDs', () => {
  const sent = sendSchema.parse({ threadId: 'local:thread', message: 'hi', correlationId: 'local:corr', replyTo: 'local:msg', expectedTurnId: 'local:turn' });
  expect(sent).toMatchObject({ threadId: 'thread', correlationId: 'local:corr', replyTo: 'local:msg', expectedTurnId: 'local:turn' });
  expect(waitSchema.parse({ threadId: 'local:thread', turnId: 'local:turn', messageId: 'local:msg' })).toMatchObject({ threadId: 'thread', turnId: 'local:turn', messageId: 'local:msg' });
});

it('keeps remote ownership for a CDP sidebar row and excludes unknown providers', () => {
  const remote = { ...row('local:remote'), location: 'remote' as const, hostId: 'fixture-new-host', hostName: 'Fixture Host', modelProvider: 'fixture-new-provider' };
  const base = { backend: 'cdp' as const, limit: 50, threads: [row('local:remote')] };
  const listed = finalizeThreadList(base, { limit: 50, remotes: [remote], host: remote.hostId, modelProvider: remote.modelProvider });
  expect(listed.threads).toHaveLength(1);
  expect(listed.threads[0]).toMatchObject({ location: 'remote', hostId: remote.hostId });
  expect(finalizeThreadList({ ...base, threads: [] }, { limit: 50, remotes: [{ ...remote, modelProvider: null }], modelProvider: remote.modelProvider }).threads).toEqual([]);
});

it('filters remote search results even when app-server fails', async () => {
  const facade = new ChatGptDesktopFacade({ connect: async () => {}, listThreads: async () => ({ backend: 'cdp', limit: 50, threads: [] }) } as unknown as ChatGptDesktopAdapter, 9222, {
    searchThreads: async () => { throw new Error('offline'); },
    listRemoteThreads: () => [{ ...row('local:unrelated'), location: 'remote', hostId: 'fixture', hostName: null }],
  } as never);
  expect((await facade.searchThreads({ query: 'needle' })).threads).toEqual([]);
});

async function connectedAdapter(state: Record<string, unknown>, open = true) {
  rstest.spyOn(CdpSession.prototype, 'connect').mockResolvedValue({});
  rstest.spyOn(CdpSession.prototype, 'closed', 'get').mockReturnValue(false);
  rstest.spyOn(CdpSession.prototype, 'send').mockImplementation(async (method) => (method === 'Target.getTargets'
    ? { targetInfos: [{ targetId: 'main', type: 'page', url: 'app://-/index.html' }] }
    : { sessionId: 'page' }) as never);
  rstest.spyOn(CdpSession.prototype, 'evaluate').mockImplementation(async expression => {
    if (expression === REPLY_STATE_EXPRESSION) return state as never;
    if (expression === CONVERSATION_ID_EXPRESSION) return 'thread' as never;
    if (expression === LOADING_TASK_GONE_EXPRESSION) return true as never;
    return { ok: open, error: 'thread-not-found' } as never;
  });
  const adapter = new CdpChatGptDesktopAdapter();
  await adapter.connect({ port: 9222 });
  return adapter;
}

it('does not report a streaming partial reply as completed after timeout', async () => {
  const adapter = await connectedAdapter({ stopVisible: true, finalAssistantCount: 1, reply: 'partial', conversationId: 'thread', lastTurnKey: 'turn', finalTurnKey: 'turn' });
  expect((await adapter.waitForReply({ threadId: 'local:thread', timeoutMs: 1 })).delivery).toBe('timeout');
});

it('propagates failure to open the requested thread instead of reading another chat', async () => {
  const adapter = await connectedAdapter({ stopVisible: false, finalAssistantCount: 1, reply: 'wrong chat', conversationId: 'other', lastTurnKey: 'turn', finalTurnKey: 'turn' }, false);
  await expect(adapter.waitForReply({ threadId: 'local:thread', timeoutMs: 1 })).rejects.toThrow('not found');
});

it('recognizes completion when a final marker already existed while streaming', async () => {
  let call = 0;
  const session = { evaluate: async () => ({ stopVisible: call++ === 0, finalAssistantCount: 1, reply: 'final', conversationId: 'thread', lastTurnKey: 'turn', finalTurnKey: 'turn' }) };
  await expect(waitForReplyDone(session as never, 'page', { timeoutMs: 300, baselineFinalCount: 1 })).resolves.toMatchObject({ reply: 'final' });
});

it('serializes Desktop operations and closes each connection on completion', async () => {
  let active = 0;
  let maxActive = 0;
  let closed = 0;
  setChatGptDesktopAdapterForTests({
    connect: async () => { active++; maxActive = Math.max(maxActive, active); },
    status: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { reachable: true, port: 9222, host: '127.0.0.1', message: 'ok', exitCode: 0 }; },
    close: async () => { active--; closed++; },
  } as unknown as ChatGptDesktopAdapter);
  await Promise.all([statusOperation({}), statusOperation({})]);
  expect(maxActive).toBe(1);
  expect(closed).toBe(2);
});

it('waits through an old conversation rendered before Loading task appears', async () => {
  const { waitForLoadingTaskGone } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
  let reads = 0;
  const session = { evaluate: async (expression: string) => expression === CONVERSATION_ID_EXPRESSION ? (++reads === 1 ? 'old-thread' : 'wanted-thread') : true };
  await waitForLoadingTaskGone(session as never, 'page', { timeoutMs: 600, threadId: 'local:wanted-thread' });
  expect(reads).toBe(2);
});

it('does not accept an old final reply when the latest user turn is unanswered', async () => {
  const session = { evaluate: async () => ({ stopVisible: false, finalAssistantCount: 1, reply: 'old', conversationId: 'thread', lastTurnKey: 'new-turn', finalTurnKey: 'old-turn' }) };
  await expect(waitForReplyDone(session as never, 'page', { timeoutMs: 10 })).rejects.toThrow('did not finish');
});

it('rejects a conversation switch while waiting for a specific thread', async () => {
  const session = { evaluate: async () => ({ stopVisible: false, finalAssistantCount: 1, reply: 'other', conversationId: 'other', lastTurnKey: 'turn', finalTurnKey: 'turn' }) };
  await expect(waitForReplyDone(session as never, 'page', { timeoutMs: 10, expectedConversationId: 'wanted' })).rejects.toThrow('changed');
});

it('does not silently create a generic chat when the requested project is missing', async () => {
  const { startNewChatExpression } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
  let clicks = 0;
  const document = { querySelector: () => null, querySelectorAll: () => [{ textContent: 'New chat', click: () => clicks++ }] };
  const result = new Function('document', `return ${startNewChatExpression('fixture-project')}`)(document);
  expect(result.ok).toBe(false);
  expect(clicks).toBe(0);
});

it('rejects non-loopback debugger URLs even for HTTP-only status discovery', async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://192.0.2.1:9222/devtools/browser/x' })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(CdpSession.fetchVersion((server.address() as AddressInfo).port)).rejects.toMatchObject({ code: 'CDP_HOST_REJECTED' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('aborts a CDP HTTP response that never finishes its body', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(CdpSession.fetchVersion((server.address() as AddressInfo).port, { signal: AbortSignal.timeout(30) })).rejects.toThrow();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('reads empty history and requests explicit ascending/full or descending/recent pages', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const { appServerReadThread } = await import('../../src/core/chatgpt-desktop/app-server-fallback.js');
  const calls: Array<Record<string, unknown>> = [];
  let empty = true;
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/read') return { thread: { id: 'review-thread' } };
      calls.push(params);
      const ids = params.sortDirection === 'asc' ? ['old', 'new'] : ['new', 'old'];
      return { data: empty ? [] : ids.map(id => ({ id, items: [] })), nextCursor: null };
    },
  } } as never);
  expect((await appServerReadThread({ threadId: 'review-thread' })).turns).toEqual([]);
  empty = false;
  expect((await appServerReadThread({ threadId: 'review-thread', limit: 2 })).turns.map(t => t.turnKey)).toEqual(['history-content:turn:old', 'history-content:turn:new']);
  await appServerReadThread({ threadId: 'review-thread', limit: 2, full: true });
  expect(calls.map(c => c.sortDirection)).toEqual(['desc', 'desc', 'asc']);
  expect(calls.at(-1)?.limit).toBe(2);
});

it('keeps provider discovery dynamic and combines local and remote provider IDs', async () => {
  const provider = `provider-${crypto.randomUUID()}`;
  const host = `host-${crypto.randomUUID()}`;
  const remote = { ...row('local:remote'), location: 'remote' as const, hostId: host, hostName: host, modelProvider: provider };
  const facade = new ChatGptDesktopFacade({} as ChatGptDesktopAdapter, 9222, {
    listThreads: async () => ({ threads: [], backend: 'app-server', limit: 50 }),
    listRemoteThreads: () => [remote],
    listHosts: () => [],
    discoverModelProviders: async () => ({ providers: ['fixture-local-provider'], source: 'thread/list-distinct' }),
  } as never);
  const result = await facade.listHosts();
  expect(result.hosts.map(h => h.hostId)).toContain(host);
  expect(result.modelProviders).toContain(provider);
});

it('bounds an unanswered CDP command and rejects pending commands on close', async () => {
  let socket: EventTarget;
  class SilentSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    constructor() { super(); socket = this; }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  rstest.stubGlobal('WebSocket', SilentSocket);
  rstest.useFakeTimers();
  rstest.spyOn(CdpSession, 'fetchVersion').mockResolvedValue({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/test' });
  const session = new CdpSession(9222);
  try {
    const connecting = session.connect();
    await Promise.resolve();
    socket!.dispatchEvent(new Event('open'));
    await connecting;
    const timedOut = expect(session.send('Runtime.evaluate')).rejects.toThrow('timed out');
    await rstest.advanceTimersByTimeAsync(10001);
    await timedOut;
    const closed = expect(session.send('Target.getTargets')).rejects.toThrow('closed');
    session.close();
    await closed;
  } finally { session.close(); rstest.useRealTimers(); rstest.unstubAllGlobals(); }
});

it('submits once even while the Send button lingers, and refuses an existing draft', async () => {
  const { FOCUS_COMPOSER_EXPRESSION, sendMessageInDom } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
  const commands: string[] = [];
  const session = {
    evaluate: async (expression: string) => expression === FOCUS_COMPOSER_EXPRESSION ? { ok: true } : true,
    send: async (method: string, params: Record<string, unknown>) => { commands.push(`${method}:${params.type || ''}`); },
  };
  expect(await sendMessageInDom(session as never, 'page', 'hello')).toEqual({ sentVia: 'enter' });
  expect(commands).toEqual(['Input.insertText:', 'Input.dispatchKeyEvent:rawKeyDown', 'Input.dispatchKeyEvent:keyUp']);
  const document = { querySelector: () => ({ textContent: 'unsent draft', focus: () => { throw new Error('must not focus'); } }) };
  expect(new Function('document', `return ${FOCUS_COMPOSER_EXPRESSION}`)(document)).toEqual({ ok: false, error: 'composer-has-draft' });
});

it('does not relabel a failed Enter acknowledgment as a safe rejection', async () => {
  const { sendMessageInDom } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
  const session = {
    evaluate: async () => ({ ok: true }),
    send: async (method: string) => { if (method === 'Input.dispatchKeyEvent') throw new Error('lost connection'); },
  };
  await expect(sendMessageInDom(session as never, 'page', 'hello')).rejects.toMatchObject({ delivery: 'unknown', reason: 'submission-unconfirmed' });
});

it('waits for the real conversation when given the special new-thread target', async () => {
  const state = { stopVisible: true, finalAssistantCount: 1, reply: 'final', conversationId: 'thread', lastTurnKey: 'turn', finalTurnKey: 'turn' };
  const adapter = await connectedAdapter(state);
  const timer = setTimeout(() => { state.stopVisible = false; }, 10);
  try {
    expect(await adapter.waitForReply({ threadId: 'new', timeoutMs: 500 })).toMatchObject({ threadId: 'local:thread', delivery: 'replied' });
  } finally { clearTimeout(timer); }
});

it('serializes nested optional fields without rejecting successful reads', async () => {
  const { readThreadOperation } = await import('../../src/core/chatgpt-desktop/routes.js');
  setChatGptDesktopAdapterForTests({
    connect: async () => {}, close: async () => {},
    readThread: async () => ({ threadId: 'thread', backend: 'cdp', turns: [{ turnKey: 'turn', role: 'assistant', text: 'reply', userText: undefined }], limit: 1, full: false }),
  } as unknown as ChatGptDesktopAdapter);
  expect(await readThreadOperation({ threadId: 'thread', limit: 1, full: false, openTimeoutMs: 100 })).toMatchObject({ exitCode: 0, turns: [{ text: 'reply' }] });
});
