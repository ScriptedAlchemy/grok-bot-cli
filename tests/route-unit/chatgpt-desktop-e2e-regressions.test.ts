import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, rstest } from '@rstest/core';
import { findRemoteThreadHost } from '../../src/core/codex/remote-control.js';
import { listDiscoveredHosts, listRemoteThreadsFromState } from '../../src/core/chatgpt-desktop/remote-threads.js';
import { ChatGptDesktopFacade, finalizeThreadList } from '../../src/core/chatgpt-desktop/facade.js';
import { appServerListThreads, appServerReadThread, appServerSearchThreads, discoverModelProviders } from '../../src/core/chatgpt-desktop/app-server-fallback.js';
import { DESKTOP_RESULT_BUDGET_BYTES, serializedBytes } from '../../src/core/chatgpt-desktop/payload-budget.js';
import { findLocalProject, resolveThreadProjects } from '../../src/core/chatgpt-desktop/project-state.js';
import { ARCHIVED_THREAD_EXPRESSION, CLEAR_NEW_CHAT_PROJECT_EXPRESSION, CONVERSATION_ID_EXPRESSION, LOADING_TASK_GONE_EXPRESSION, navigateToThreadExpression, openThreadInDom, readTurnsFromDom, startNewChatExpression, startNewChatInDom, waitForLoadingTaskGone } from '../../src/core/chatgpt-desktop/cdp-dom.js';
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

it('resolves local and remote project labels from assignments, root hints, and cwd', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbot-project-state-'));
  try {
    writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({
      'electron-persisted-atom-state': {
        'local-projects': { core: { id: 'core-id', name: 'core', rootPaths: ['/work/core'] },
          lra: { id: 'lra-id', name: 'codex-lra', rootPaths: ['/work/lra'] } },
        'remote-projects': [{ id: 'remote-id', hostId: 'remote-host', remotePath: '/fast/core', label: 'remote-core' }],
        'thread-project-assignments': { assigned: { projectKind: 'local', projectId: 'core-id' },
          remote: { projectKind: 'remote', projectId: 'remote-id', hostId: 'remote-host' } },
        'thread-workspace-root-hints': { hinted: '/work/lra/subfolder' },
        'projectless-thread-ids': ['projectless'],
      },
    }));
    const row = (id: string, cwd: string) => ({ threadId: `local:${id}`, title: id, cwd,
      pinned: false, selected: false, kind: 'codex' });
    const rows = resolveThreadProjects([row('assigned', '/elsewhere'), row('hinted', '/elsewhere'),
      row('cwd', '/work/core/subfolder'), row('projectless', '/work/core'),
      { ...row('remote', '/fast/core/subfolder'), location: 'remote', hostId: 'remote-host', hostName: null,
        project: '/fast/core/subfolder' }], { CODEX_HOME: home });
    expect(rows.map((thread) => [thread.project, thread.projectId])).toEqual([
      ['core', 'core-id'], ['codex-lra', 'lra-id'], ['core', 'core-id'], [null, null], ['remote-core', 'remote-id'],
    ]);
    expect(rows[0].projectRootPath).toBe('/work/core');
    expect(findLocalProject('codex-lra', { CODEX_HOME: home })).toMatchObject({ id: 'lra-id', rootPaths: ['/work/lra'] });
    const filtered = finalizeThreadList({ backend: 'app-server', limit: 10, threads: rows },
      { limit: 10, project: 'core', remotes: [] });
    expect(filtered.threads.map((thread) => thread.threadId)).toEqual(['local:assigned', 'local:cwd', 'local:remote']);
    expect(finalizeThreadList({ backend: 'app-server', limit: 10, threads: rows },
      { limit: 10, project: 'lra-id', remotes: [] }).threads.map((thread) => thread.threadId)).toEqual(['local:hinted']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('counts CDP-only remote rows in host discovery', async () => {
  const row = { threadId: 'local:cdp-only', title: 'remote', pinned: false, selected: false, kind: 'remote', location: 'remote' as const, hostId: 'remote:dynamic', hostName: null };
  const local = { threadId: 'local:local-cdp-only', title: 'local', pinned: false, selected: false, kind: 'codex', location: 'local' as const };
  const facade = new ChatGptDesktopFacade({
    connect: async () => {}, listThreads: async () => ({ backend: 'cdp', limit: 200, threads: [row, local] }),
  } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async () => ({ backend: 'app-server', limit: 25, threads: [] }),
    listRemoteThreads: () => [], listHosts: () => [{ hostId: 'local', hostName: 'local', location: 'local', threadCount: 0 }],
    discoverModelProviders: async () => ({ providers: [], source: 'thread/list-distinct', threadCount: 0, complete: true }),
  } as never);
  expect((await facade.listHosts()).hosts).toEqual(expect.arrayContaining([expect.objectContaining({ hostId: 'remote:dynamic', threadCount: 1 })]));
  expect((await facade.listHosts()).hosts.find((host) => host.hostId === 'local')?.threadCount).toBe(1);
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
  expect((await facade.listHosts()).warnings).toEqual(expect.arrayContaining(['Model provider discovery failed: frame too large']));
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

it('pages one sorted merged inventory exactly once across app, CDP and remote rows', async () => {
  const row = (id: string, updatedAt: number) => ({ threadId: `local:${id}`, title: id,
    updatedAt, pinned: false, selected: false, kind: 'codex' });
  const app = [row('a', 900), row('b', 800), row('c', 700), row('d', 600), row('e', 500), row('f', 400)];
  const cdp = [{ ...row('a', 900), selected: true }, { ...row('c', 700), location: 'remote' as const, hostId: 'host', hostName: null }, row('sidebar-only', 550)];
  const remote = [{ ...row('c', 700), location: 'remote' as const, hostId: 'host', hostName: null },
    { ...row('remote-only', 750), location: 'remote' as const, hostId: 'host', hostName: null }];
  const calls: unknown[] = [];
  const facade = new ChatGptDesktopFacade({ connect: async () => {},
    listThreads: async () => ({ backend: 'cdp', limit: 200, threads: cdp }) } as unknown as ChatGptDesktopAdapter, 9222, {
    listThreads: async ({ cursor }: { cursor?: string }) => {
      calls.push(cursor);
      const offset = Number(cursor ?? 0);
      return { backend: 'app-server', limit: 200, threads: app.slice(offset, offset + 2),
        nextCursor: offset + 2 < app.length ? String(offset + 2) : null };
    },
    listRemoteThreads: () => remote,
  } as never);
  const pages = [];
  let cursor: string | null | undefined;
  do {
    const out = await facade.listThreads({ limit: 3, ...(cursor ? { cursor } : {}) });
    pages.push(out);
    cursor = out.nextCursor;
  } while (cursor);
  expect(pages.map((page) => page.threads.length)).toEqual([3, 3, 2]);
  expect(pages.flatMap((page) => page.threads.map((thread) => thread.threadId))).toEqual([
    'local:a', 'local:b', 'local:remote-only', 'local:c', 'local:d', 'local:sidebar-only', 'local:e', 'local:f',
  ]);
  expect(pages[1].threads.find((thread) => thread.threadId === 'local:c')?.location).toBe('remote');
  expect(calls).toEqual([undefined, '2', '4']);
  await expect(facade.listThreads({ limit: 3, cursor: pages[0].nextCursor!, host: 'local' })).rejects.toThrow('filters');
  expect(listThreadsSchema.parse({ cursor: pages[0].nextCursor }).cursor).toBe(pages[0].nextCursor);
  setChatGptDesktopAdapterForTests({ connect: async () => {}, close: async () => {},
    listThreads: async (options: { cursor?: string } = {}) => ({ backend: 'app-server', limit: 1, nextCursor: options.cursor, threads: [] }) } as unknown as ChatGptDesktopAdapter);
  expect(await listThreadsOperation(listThreadsSchema.parse({ cursor: pages[0].nextCursor }))).toMatchObject({ nextCursor: pages[0].nextCursor, exitCode: 0 });
});

it('fills a 100-row app-server page using bounded 25-row RPC requests', async () => {
  const bridge = await import('../../src/core/codex-bridge.js');
  const limits: number[] = [];
  rstest.spyOn(bridge, 'listCodexThreads').mockImplementation(async ({ limit, cursor } = {}) => {
    limits.push(limit!);
    const offset = Number(cursor ?? 0);
    return { limit: limit!, threads: Array.from({ length: Math.min(limit!, 120 - offset) }, (_, i) => ({
      id: `id-${offset + i}`, name: `title-${offset + i}` })),
      nextCursor: offset + limit! < 120 ? String(offset + limit!) : null } as never;
  });
  const first = await appServerListThreads({ limit: 100 });
  const second = await appServerListThreads({ limit: 100, cursor: first.nextCursor! });
  expect([first.threads.length, second.threads.length]).toEqual([100, 20]);
  expect([...first.threads, ...second.threads].map((row) => row.threadId)).toEqual(
    Array.from({ length: 120 }, (_, i) => `local:id-${i}`));
  expect(limits).toEqual([25, 25, 25, 25, 25]);
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
      ? { x: 12, y: 14, visible: true, disabled: false }
      : expression.includes('const expected =') ? { ready: true, path: '/', composer: true, scope: 'Change project: core' }
      : { ok: true, via: 'project', hoverX: 8, hoverY: 10 },
    send: async (_method: string, params: { type: string }) => { sent.push(params.type); },
  };
  await startNewChatInDom(session as never, 'page', { project: 'core' });
  expect(sent).toEqual(['mouseMoved', 'mouseMoved', 'mousePressed', 'mouseReleased']);
});

it('rejects a disabled project action before sending and reports a failed navigation quickly', async () => {
  const sent: string[] = [];
  const disabled = { evaluate: async () => ({ ok: true, via: 'project', disabled: true, hoverX: 8, hoverY: 10 }),
    send: async (method: string) => { sent.push(method); } };
  await expect(startNewChatInDom(disabled as never, 'page', { project: 'missing-root' })).rejects.toMatchObject({ code: 'PROJECT_UNAVAILABLE' });
  expect(sent).toEqual([]);
  const noNavigation = { evaluate: async (expression: string) => expression.includes('const expected =')
    ? { ready: false, path: '/local/old', composer: false, scope: '' }
    : expression.includes('getComputedStyle') ? { x: 12, y: 14, visible: true, disabled: false }
    : { ok: true, via: 'project', hoverX: 8, hoverY: 10 }, send: async () => {} };
  await expect(startNewChatInDom(noNavigation as never, 'page', { project: 'core', navigationTimeoutMs: 20 }))
    .rejects.toMatchObject({ code: 'NEW_CHAT_NAVIGATION_FAILED' });
});

it('clears a retained project before treating a new chat as projectless', async () => {
  let cleared = false;
  const session = { evaluate: async (expression: string) => {
    if (expression === CLEAR_NEW_CHAT_PROJECT_EXPRESSION) { cleared = true; return true; }
    if (expression.includes('const expected =')) return { ready: cleared, path: '/', composer: true,
      scope: cleared ? 'Choose project' : 'Change project: core' };
    return { ok: true, via: 'fallback' };
  } };
  expect(await startNewChatInDom(session as never, 'page')).toEqual({ via: 'fallback' });
  expect(cleared).toBe(true);
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
