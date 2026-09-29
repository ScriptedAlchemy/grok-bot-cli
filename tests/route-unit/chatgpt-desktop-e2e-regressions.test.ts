import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, rstest } from '@rstest/core';
import { findRemoteThreadHost } from '../../src/core/codex/remote-control.js';
import { listDiscoveredHosts, listRemoteThreadsFromState } from '../../src/core/chatgpt-desktop/remote-threads.js';
import { ChatGptDesktopFacade, finalizeThreadList } from '../../src/core/chatgpt-desktop/facade.js';
import { appServerListThreads, appServerReadThread, appServerSearchThreads, discoverModelProviders } from '../../src/core/chatgpt-desktop/app-server-fallback.js';
import { DESKTOP_RESULT_BUDGET_BYTES, serializedBytes } from '../../src/core/chatgpt-desktop/payload-budget.js';
import { ARCHIVED_THREAD_EXPRESSION, CONVERSATION_ID_EXPRESSION, LOADING_TASK_GONE_EXPRESSION, navigateToThreadExpression, openThreadInDom, readTurnsFromDom, startNewChatExpression, startNewChatInDom, waitForLoadingTaskGone } from '../../src/core/chatgpt-desktop/cdp-dom.js';
import { listThreadsOperation, listThreadsSchema, readThreadOperation, readThreadSchema, searchThreadsSchema, statusOperation } from '../../src/core/chatgpt-desktop/routes.js';
import { setChatGptDesktopAdapterForTests } from '../../src/core/chatgpt-desktop/facade.js';
import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';

afterEach(() => { rstest.restoreAllMocks(); setChatGptDesktopAdapterForTests(null); });

it('reads nested remote summaries and SSH connections without inventing a display name', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbot-remote-state-'));
  try {
    writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': {
        'remote-thread-summaries-v3:remote-control:env_dynamic': [
          { conversationId: 'remote-thread', hostId: 'remote-control:env_dynamic', title: 'TD v2', modelProvider: 'openai' },
        ],
      },
      'codex-managed-remote-connections': [{ hostId: 'ssh:dynamic', displayName: 'ssh-box' }],
    }));
    const env = { CODEX_HOME: home };
    expect(listRemoteThreadsFromState(env)[0]).toMatchObject({ threadId: 'local:remote-thread', hostId: 'remote-control:env_dynamic', hostName: null });
    expect(findRemoteThreadHost('local:remote-thread', env)).toEqual({ hostId: 'remote-control:env_dynamic', hostName: null });
    expect(listDiscoveredHosts(env)).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: 'remote-control:env_dynamic', hostName: null, threadCount: 1 }),
      expect.objectContaining({ hostId: 'ssh:dynamic', hostName: 'ssh-box' }),
    ]));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('joins a CDP row to remote ownership and reports mixed backends', () => {
  const row = { threadId: 'local:remote-thread', title: 'TD v2', pinned: false, selected: true, kind: 'remote' };
  const out = finalizeThreadList({ backend: 'app-server+cdp', limit: 20, threads: [row] }, {
    limit: 20, host: 'env_dynamic', remotes: [{ ...row, selected: false, location: 'remote', hostId: 'remote-control:env_dynamic', hostName: null }],
  });
  expect(out).toMatchObject({ backend: 'app-server+cdp+remote-state', threads: [{ location: 'remote', hostId: 'remote-control:env_dynamic', selected: true }] });
});

it('filters thread rows by dynamic project label or projectId', () => {
  const row = (id: string, project: string, projectId: string) => ({
    threadId: `local:${id}`, title: id, project, projectId, pinned: false, selected: false, kind: 'codex',
  });
  const base = { backend: 'app-server' as const, limit: 10, threads: [row('one', 'core', 'project-1'), row('two', 'other', 'project-2')] };
  expect(finalizeThreadList(base, { limit: 10, project: 'core', remotes: [] }).threads.map((thread) => thread.threadId)).toEqual(['local:one']);
  expect(finalizeThreadList(base, { limit: 10, project: 'project-2', remotes: [] }).threads.map((thread) => thread.threadId)).toEqual(['local:two']);
});

it('counts CDP-only remote rows in host discovery', async () => {
  const row = { threadId: 'local:cdp-only', title: 'remote', pinned: false, selected: false, kind: 'remote', location: 'remote' as const, hostId: 'remote:dynamic', hostName: null };
  const facade = new ChatGptDesktopFacade({
    connect: async () => {}, listThreads: async () => ({ backend: 'cdp', limit: 200, threads: [row] }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async () => ({ backend: 'app-server', limit: 25, threads: [] }),
    listRemoteThreads: () => [], listHosts: () => [{ hostId: 'local', hostName: 'local', location: 'local', threadCount: 0 }],
    discoverModelProviders: async () => ({ providers: [], source: 'thread/list-distinct', threadCount: 0, complete: true }),
  } as never);
  expect((await facade.listHosts()).hosts).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 'remote:dynamic', threadCount: 1 })]));
});

it('uses the same deduplicated remote rows for host count and host-filtered list', async () => {
  const row = (id: string) => ({ threadId: `local:${id}`, title: id, pinned: false, selected: false,
    kind: 'remote', location: 'remote' as const, hostId: 'remote:one', hostName: null });
  const facade = new ChatGptDesktopFacade({
    connect: async () => {}, listThreads: async () => ({ backend: 'cdp', limit: 200,
      threads: [row('shared'), row('cdp-only')] }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async () => ({ backend: 'app-server', limit: 25, threads: [] }),
    listRemoteThreads: () => [row('shared'), row('state-only')],
    listHosts: () => [{ hostId: 'remote:one', hostName: 'host'.repeat(2000), location: 'remote', threadCount: 2 }],
    discoverModelProviders: async () => ({ providers: [], source: 'thread/list-distinct', threadCount: 0, complete: true }),
  } as never);
  const hosts = await facade.listHosts();
  const listed = await facade.listThreads({ host: 'remote:one', limit: 100 });
  expect(hosts.hosts.find((host) => host.hostId === 'remote:one')?.threadCount).toBe(listed.threads.length);
  expect(hosts.hosts.find((host) => host.hostId === 'remote:one')).toMatchObject({ hostNameTruncated: true });
  expect(listed.threads.map((thread) => thread.threadId).sort()).toEqual(['local:cdp-only', 'local:shared', 'local:state-only']);
});

it('surfaces provider discovery errors with the remote fallback', async () => {
  const facade = new ChatGptDesktopFacade({} as ChatGptDesktopAdapter, 9222, {
    listThreads: async () => ({ backend: 'app-server', limit: 25, threads: [] }),
    listRemoteThreads: () => [], listHosts: () => [],
    discoverModelProviders: async () => { throw new Error('frame too large'); },
  } as never);
  expect((await facade.listHosts()).warnings).toEqual(['Model provider discovery failed: frame too large']);
});

it('uses small app-server pages for provider discovery and search', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const limits: number[] = [];
  rstest.spyOn(bridge, 'listCodexThreads').mockImplementation(async ({ limit, cursor } = {}) => {
    limits.push(limit!);
    return { limit: limit!, nextCursor: cursor ? null : 'more', threads: [{ id: cursor ? 'b' : 'a', name: cursor ? 'needle' : 'first', modelProvider: cursor ? 'second-provider' : 'first-provider' }] } as never;
  });
  expect((await discoverModelProviders()).providers).toEqual(['first-provider', 'second-provider']);
  expect((await appServerSearchThreads({ query: 'needle' })).threads).toHaveLength(1);
  expect(limits).toEqual([25, 25, 25, 25]);
});

it('pages full turn reads, extracts user content and completedAt, and keeps stable keys', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const limits: number[] = [];
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/read') return { thread: { id: 'long-thread' } };
      limits.push(params.limit as number);
      const id = params.cursor ? 'second' : 'first';
      return { data: [{ id, startedAt: 10, completedAt: 20, items: [
        { type: 'userMessage', content: [{ type: 'text', text: `ask ${id}` }] },
        { type: 'agentMessage', text: `answer ${id}` },
      ] }], nextCursor: params.cursor ? null : 'more' };
    },
  } } as never);
  const out = await appServerReadThread({ threadId: 'long-thread', full: true, limit: 20 });
  expect(out.complete).toBe(true);
  expect(out.turns).toMatchObject([
    { turnKey: 'history-content:turn:first', userText: 'ask first', assistantText: 'answer first', endedAt: 20 },
    { turnKey: 'history-content:turn:second', userText: 'ask second', endedAt: 20 },
  ]);
  expect(limits).toEqual([10, 10]);
});

it('completes a 146-turn full read in bounded pages', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const pages: number[] = [];
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/read') return { thread: { id: 'long-thread' } };
      const offset = Number(params.cursor ?? 0);
      const size = Math.min(params.limit as number, 146 - offset);
      pages.push(params.limit as number);
      return { data: Array.from({ length: size }, (_, i) => ({ id: `turn-${offset + i}`, items: [] })),
        nextCursor: offset + size < 146 ? String(offset + size) : null };
    },
  } } as never);
  const out = await appServerReadThread({ threadId: 'long-thread', full: true, limit: 200 });
  expect(out.turns).toHaveLength(146);
  expect(out.complete).toBe(true);
  expect(pages).toHaveLength(15);
  expect(Math.max(...pages)).toBe(10);
});

it('pages a serialized history above the document budget without losing turns', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/read') return { thread: { id: 'huge' } };
      const offset = Number(params.cursor ?? 0);
      return { data: Array.from({ length: Math.min(10, 30 - offset) }, (_, i) => ({
        id: `turn-${offset + i}`, items: [{ type: 'agentMessage', text: 'x'.repeat(30_000) }],
      })), nextCursor: offset + 10 < 30 ? String(offset + 10) : null };
    },
  } } as never);
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const out = await appServerReadThread({ threadId: 'huge', full: true, cursor });
    expect(serializedBytes(out)).toBeLessThan(DESKTOP_RESULT_BUDGET_BYTES);
    keys.push(...out.turns.map((turn) => turn.turnKey));
    if (out.complete) break;
    expect(out.nextCursor).toBeTruthy();
    cursor = out.nextCursor!;
  }
  expect(keys).toEqual(Array.from({ length: 30 }, (_, i) => `history-content:turn:turn-${i}`));
});

it('splits one oversized turn into lossless ordered field fragments with a stable key', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const userText = 'u'.repeat(700_000);
  const assistantText = 'a'.repeat(700_000);
  rstest.spyOn(bridge, 'openCodexSession').mockResolvedValue({ client: {
    close() {},
    async request(method: string) {
      if (method === 'thread/read') return { thread: { id: 'giant' } };
      return { data: [{ id: 'giant-turn', items: [
        { type: 'userMessage', text: userText }, { type: 'agentMessage', text: assistantText },
      ] }], nextCursor: null };
    },
  } } as never);
  const fields = { text: '', userText: '', assistantText: '' };
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const out = await appServerReadThread({ threadId: 'giant', full: true, cursor });
    expect(serializedBytes(out)).toBeLessThan(DESKTOP_RESULT_BUDGET_BYTES);
    for (const turn of out.turns) {
      expect(turn.turnKey).toBe('history-content:turn:giant-turn');
      expect(turn.textTruncated).toBe(true);
      const field = turn.continuation!.field;
      expect(turn.continuation!.offsetChars).toBe(fields[field].length);
      fields[field] += turn[field] ?? '';
    }
    if (out.complete) break;
    cursor = out.nextCursor!;
  }
  expect(fields).toEqual({ text: assistantText, userText, assistantText });
});

it('compacts oversized list titles across pages and searches the original full title', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const title = `${'x'.repeat(7_400)} unique-tail`;
  rstest.spyOn(bridge, 'listCodexThreads').mockImplementation(async ({ cursor } = {}) => {
    const offset = Number(cursor ?? 0);
    return { limit: 25, threads: Array.from({ length: Math.min(25, 60 - offset) }, (_, i) => ({
      id: `id-${offset + i}`, name: title,
    })), nextCursor: offset + 25 < 60 ? String(offset + 25) : null } as never;
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const out = await appServerListThreads({ limit: 100, cursor });
    expect(serializedBytes(out)).toBeLessThan(DESKTOP_RESULT_BUDGET_BYTES);
    expect(out.threads.every((row) => row.title.length <= 200 && row.titleTruncated)).toBe(true);
    ids.push(...out.threads.map((row) => row.threadId));
    if (!out.nextCursor) break;
    cursor = out.nextCursor;
  }
  expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => `local:id-${i}`));
  const search = await appServerSearchThreads({ query: 'unique-tail', limit: 10 });
  expect(search.threads).toHaveLength(10);
  expect(search.threads[0].titleTruncated).toBe(true);
  expect((await appServerSearchThreads({ query: 'unique-tail', limit: 10, cursor: search.nextCursor! })).threads[0].threadId).toBe('local:id-10');
  expect(searchThreadsSchema.parse({ query: 'unique-tail', cursor: search.nextCursor }).cursor).toBe(search.nextCursor);
  expect(readThreadSchema.parse({ threadId: 'giant', cursor: 'opaque' }).cursor).toBe('opaque');
});

it('defaults full reads to the bounded complete-history limit', async () => {
  const limits: number[] = [];
  setChatGptDesktopAdapterForTests({
    connect: async () => {}, close: async () => {},
    readThread: async (options: { threadId: string; limit?: number; full?: boolean }) => {
      limits.push(options.limit!);
      return { threadId: options.threadId, turns: [], backend: 'app-server', limit: options.limit!, full: Boolean(options.full), complete: true };
    },
  } as unknown as ChatGptDesktopAdapter);
  await readThreadOperation(readThreadSchema.parse({ threadId: 'example', full: true }));
  await readThreadOperation(readThreadSchema.parse({ threadId: 'example' }));
  expect(limits).toEqual([2000, 100]);
});

it('marks a CDP read partial and preserves the app-server failure', async () => {
  const facade = new ChatGptDesktopFacade({
    connect: async () => {},
    readThread: async () => ({ threadId: 'local:example', turns: [], backend: 'cdp', limit: 100, full: true }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    readThread: async () => { throw new Error('frame exceeds 16 MiB'); },
  } as never);
  expect(await facade.readThread({ threadId: 'local:example', full: true })).toMatchObject({
    backend: 'cdp', complete: false, warnings: ['App-server read failed: frame exceeds 16 MiB'],
  });
});

it('passes the opaque list cursor through facade and route', async () => {
  const calls: unknown[] = [];
  const facade = new ChatGptDesktopFacade({ connect: async () => { throw new Error('offline'); } } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async (options: { cursor?: string; limit?: number }) => { calls.push(options.cursor); return { backend: 'app-server', limit: options.limit ?? 50, nextCursor: 'next-page', threads: [] }; },
    listRemoteThreads: () => [],
  } as never);
  expect((await facade.listThreads({ cursor: 'previous' })).nextCursor).toBe('next-page');
  expect(calls).toEqual(['previous']);
  expect(listThreadsSchema.parse({ cursor: 'previous' }).cursor).toBe('previous');
  setChatGptDesktopAdapterForTests({ connect: async () => {}, close: async () => {}, listThreads: async (options: { cursor?: string } = {}) => ({ backend: 'app-server', limit: 1, nextCursor: options.cursor, threads: [] }) } as unknown as ChatGptDesktopAdapter);
  expect(await listThreadsOperation(listThreadsSchema.parse({ cursor: 'previous' }))).toMatchObject({ nextCursor: 'previous', exitCode: 0 });
});

it('reserves first-page space for remote rows without skipping local cursor rows', async () => {
  const row = (id: string) => ({ threadId: `local:${id}`, title: id, pinned: false, selected: false, kind: 'codex' });
  const appCalls: Array<{ limit?: number; cursor?: string }> = [];
  const facade = new ChatGptDesktopFacade({
    connect: async () => {},
    listThreads: async () => ({ backend: 'cdp', limit: 5, threads: [{ ...row('cdp-remote'), location: 'remote', hostId: 'host', hostName: null }] }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async (options: { limit?: number; cursor?: string }) => {
      appCalls.push(options);
      const start = Number(options.cursor ?? 0);
      const count = options.limit ?? 5;
      return { backend: 'app-server', limit: count, nextCursor: String(start + count),
        threads: Array.from({ length: count }, (_, i) => row(`local-${start + i}`)) };
    },
    listRemoteThreads: () => [{ ...row('state-remote'), location: 'remote', hostId: 'host', hostName: null }],
  } as never);
  const first = await facade.listThreads({ limit: 5 });
  const second = await facade.listThreads({ limit: 5, cursor: first.nextCursor! });
  expect(first.threads).toHaveLength(5);
  expect(first.threads.filter((thread) => thread.location === 'remote')).toHaveLength(2);
  expect(appCalls).toMatchObject([{ limit: 3 }, { limit: 5, cursor: '3' }]);
  expect(second.threads[0].threadId).toBe('local:local-3');
});

it('pages remote rows before local rows when the page is smaller than remote inventory', async () => {
  const row = (id: string) => ({ threadId: `local:${id}`, title: id, pinned: false, selected: false, kind: 'remote', location: 'remote' as const, hostId: 'host', hostName: null });
  const facade = new ChatGptDesktopFacade({ connect: async () => {}, listThreads: async () => ({ backend: 'cdp', limit: 200, threads: [] }) } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async ({ cursor }: { cursor?: string }) => ({ backend: 'app-server', limit: 1, nextCursor: null,
      threads: [{ threadId: `local:${cursor ? 'next' : 'first'}`, title: 'local', pinned: false, selected: false, kind: 'codex' }] }),
    listRemoteThreads: () => [row('remote-a'), row('remote-b')],
  } as never);
  const first = await facade.listThreads({ limit: 1 });
  const second = await facade.listThreads({ limit: 1, cursor: first.nextCursor! });
  const third = await facade.listThreads({ limit: 1, cursor: second.nextCursor! });
  expect(first.threads[0].threadId).toBe('local:remote-a');
  expect(second.threads[0].threadId).toBe('local:remote-b');
  expect(third.threads[0].threadId).toBe('local:first');
});

it('reports CDP unreachable even when app-server is reachable', async () => {
  const facade = new ChatGptDesktopFacade({ status: async () => ({ reachable: false, host: '127.0.0.1', port: 9333, message: 'CDP down', exitCode: 1 }) } as unknown as ChatGptDesktopAdapter, 9333, { statusProbe: async () => ({ reachable: true }) } as never);
  expect(await facade.status()).toMatchObject({ reachable: false, exitCode: 1, appServerFallback: { reachable: true } });
  setChatGptDesktopAdapterForTests({ connect: async () => {}, close: async () => {}, status: async () => facade.status() } as unknown as ChatGptDesktopAdapter);
  expect(await statusOperation({})).toMatchObject({ reachable: false, exitCode: 1 });
});

it('hovers then dispatches a real project button press and release', async () => {
  expect(startNewChatExpression('core')).toContain('scrollIntoView');
  const sent: string[] = [];
  const session = {
    evaluate: async (expression: string) => expression.includes('getComputedStyle')
      ? { x: 12, y: 14, visible: true }
      : { ok: true, via: 'project', hoverX: 8, hoverY: 10 },
    send: async (_method: string, params: { type: string }) => { sent.push(params.type); },
  };
  await startNewChatInDom(session as never, 'page', { project: 'core' });
  expect(sent).toEqual(['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

it('uses the displayed durable id before sidebar lookup and routes missing rows', async () => {
  const expressions: string[] = [];
  const session = { evaluate: async (expression: string) => {
    expressions.push(expression);
    if (expression === CONVERSATION_ID_EXPRESSION) return expressions.length === 1 ? 'already-open' : '';
    if (expression.includes('router.navigate')) return { ok: true };
    return { ok: false, error: 'thread-not-found' };
  } };
  await openThreadInDom(session as never, 'page', 'local:already-open');
  expect(expressions).toEqual([CONVERSATION_ID_EXPRESSION]);
  await openThreadInDom(session as never, 'page', 'local:missing-row');
  expect(expressions.at(-1)).toContain("/local/missing-row");
  expect(navigateToThreadExpression('local:missing-row')).toContain('router.navigate');
});

it('orders full CDP history oldest first and deduplicates stable turn keys', async () => {
  let harvests = 0;
  const session = {
    evaluate: async (expression: string) => {
      if (expression.includes('getBoundingClientRect')) return { ok: true, x: 10, y: 10 };
      if (expression.includes('gapPrefix')) return harvests++ === 0
        ? [{ turnKey: 'history-content:turn:new', role: 'assistant', text: 'new' }]
        : [{ turnKey: 'history-content:turn:old', role: 'user', text: 'old' }, { turnKey: 'history-content:turn:new', role: 'assistant', text: 'new' }];
      return {};
    },
    send: async () => {},
  };
  const turns = await readTurnsFromDom(session as never, 'page', { full: true, limit: 10, idleWheels: 1, maxWheels: 2 });
  expect(turns.map((turn) => turn.turnKey)).toEqual(['history-content:turn:old', 'history-content:turn:new']);
});

it('reports an archived route distinctly from a loading timeout', async () => {
  const session = { evaluate: async (expression: string) => expression === ARCHIVED_THREAD_EXPRESSION ? true : expression === LOADING_TASK_GONE_EXPRESSION };
  await expect(waitForLoadingTaskGone(session as never, 'page', { threadId: 'local:archived', timeoutMs: 1000 })).rejects.toThrow('archived');
});
