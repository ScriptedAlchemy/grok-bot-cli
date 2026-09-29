import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from '@rstest/core';
import { invokeCli, invokeMcpTool, listMcpSurface } from 'agent-bundle/test';

import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';
import {
  CdpHostRejectedError,
  CdpUnreachableError,
  NotImplementedError,
  assertLoopbackHostname,
  chatgptDesktopRelaunchCommand,
  forceLoopbackWebSocketUrl,
  setChatGptDesktopAdapterForTests,
} from '../../src/core/chatgpt-desktop/index.js';
import { ChatGptDesktopFacade } from '../../src/core/chatgpt-desktop/facade.js';

const desktopTools = [
  'chatgpt_desktop_list_threads',
  'chatgpt_desktop_read_thread',
  'chatgpt_desktop_search_threads',
  'chatgpt_desktop_send',
  'chatgpt_desktop_status',
  'chatgpt_desktop_wait_reply',
] as const;

function fakeAdapter(overrides: Partial<ChatGptDesktopAdapter> = {}): ChatGptDesktopAdapter {
  const base: ChatGptDesktopAdapter = {
    async connect() {},
    async listTargets() {
      return [
        {
          targetId: 'main',
          type: 'page',
          title: 'ChatGPT',
          url: 'app://-/index.html',
          attached: true,
        },
      ];
    },
    async listThreads({ limit = 50 } = {}) {
      return {
        backend: 'cdp',
        limit,
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'Scaffold thread',
            pinned: false,
            selected: true,
            kind: 'local',
          },
        ].slice(0, limit),
      };
    },
    async readThread({ threadId, limit = 100, full = false }) {
      return {
        threadId,
        backend: 'cdp',
        limit,
        full,
        turns: [
          {
            turnKey: 't1',
            role: 'assistant',
            text: 'hi there',
            userText: 'hello',
            assistantText: 'hi there',
          },
        ],
      };
    },
    async sendMessage({ threadId, text, project }) {
      return {
        threadId: threadId ?? 'local:client-new-thread:deadbeef',
        temporaryThreadId: threadId ? undefined : 'local:client-new-thread:deadbeef',
        project,
        backend: 'cdp',
        experimental: false,
        delivery: 'accepted',
        sentVia: 'enter',
        message: text,
      };
    },
    async waitForReply({ threadId }) {
      return {
        threadId: threadId ?? 'conv-real-id',
        conversationId: 'conv-real-id',
        reply: 'hi there',
        backend: 'cdp',
        experimental: false,
        delivery: 'replied',
      };
    },
    async openThread(threadId) {
      return { threadId, backend: 'cdp' };
    },
    async status() {
      return {
        reachable: true,
        port: 9222,
        host: '127.0.0.1',
        browser: 'fake',
        message: 'ok',
        exitCode: 0,
      };
    },
    async close() {},
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  setChatGptDesktopAdapterForTests(null);
});

describe('chatgpt-desktop loopback + relaunch helpers', () => {
  it('rejects non-loopback CDP hosts and rewrites debugger URLs to 127.0.0.1', () => {
    expect(() => assertLoopbackHostname('example.com')).toThrow(CdpHostRejectedError);
    expect(() => forceLoopbackWebSocketUrl('ws://10.0.0.2:9222/devtools/browser/x')).toThrow(
      CdpHostRejectedError,
    );
    expect(forceLoopbackWebSocketUrl('ws://localhost:9222/devtools/browser/x')).toBe(
      'ws://127.0.0.1:9222/devtools/browser/x',
    );
    expect(chatgptDesktopRelaunchCommand({ port: 9333 })).toContain(
      '--remote-debugging-port=9333',
    );
    expect(chatgptDesktopRelaunchCommand({ port: 9222 })).toContain(
      'open -a /Applications/ChatGPT.app --args --remote-debugging-port=9222',
    );
  });

  it('selects only the exact main window URL and ignores overlays/webviews', async () => {
    const {
      IGNORED_TARGET_URL_MARKERS,
      MAIN_WINDOW_URL,
      COMPOSER_SELECTOR,
      SEND_BUTTON_SELECTOR,
      STOP_BUTTON_SELECTOR,
      ASSISTANT_MESSAGE_SELECTOR,
      dedupeThreadsById,
      isMainWindowTarget,
      newChatInProjectSelector,
      pickMainWindowTarget,
      summarizeTargetInfos,
    } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');

    expect(isMainWindowTarget({ type: 'page', url: MAIN_WINDOW_URL })).toBe(true);
    expect(
      isMainWindowTarget({
        type: 'page',
        url: 'app://-/index.html?initialRoute=%2Favatar-overlay',
      }),
    ).toBe(false);
    expect(isMainWindowTarget({ type: 'page', url: 'app://-/detached-window.html' })).toBe(false);
    expect(isMainWindowTarget({ type: 'page', url: 'https://chatgpt.com/pricing' })).toBe(false);
    expect(IGNORED_TARGET_URL_MARKERS.length).toBeGreaterThan(0);
    expect(COMPOSER_SELECTOR).toContain('data-codex-composer');
    expect(SEND_BUTTON_SELECTOR).toBe('button[aria-label="Send"]');
    expect(STOP_BUTTON_SELECTOR).toContain('Stop');
    expect(ASSISTANT_MESSAGE_SELECTOR).toContain('assistant-message');
    expect(newChatInProjectSelector('Launch')).toContain('Start new chat in Launch');
    expect(
      dedupeThreadsById([
        { threadId: 'a', title: '1', pinned: false, selected: false, kind: 'local' },
        { threadId: 'a', title: '1b', pinned: false, selected: true, kind: 'local' },
        { threadId: 'b', title: '2', pinned: false, selected: false, kind: 'local' },
      ]).map((t) => t.threadId),
    ).toEqual(['a', 'b']);

    const targets = summarizeTargetInfos([
      { targetId: 'overlay', type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' },
      { targetId: 'main', type: 'page', title: 'ChatGPT', url: MAIN_WINDOW_URL },
      { targetId: 'web', type: 'page', url: 'https://chatgpt.com/pricing' },
    ]);
    expect(pickMainWindowTarget(targets)?.targetId).toBe('main');
  });
});

describe('chatgpt-desktop thread id mapping', () => {
  it('maps local:<conversationId> ↔ app-server bare ids; temp rows do not map', async () => {
    const {
      LOCAL_THREAD_ID_PREFIX,
      TEMP_THREAD_ID_PREFIX,
      appServerThreadIdCandidates,
      isTemporaryDesktopThreadId,
      threadIdsEquivalent,
      toAppServerThreadId,
      toDesktopThreadId,
      toDomTurnKey,
    } = await import('../../src/core/chatgpt-desktop/index.js');

    const bare = '11111111-1111-1111-1111-111111111111';
    const local = `${LOCAL_THREAD_ID_PREFIX}${bare}`;
    expect(toAppServerThreadId(local)).toBe(bare);
    expect(toAppServerThreadId(bare)).toBe(bare);
    expect(toDesktopThreadId(bare)).toBe(local);
    expect(toDesktopThreadId(local)).toBe(local);
    expect(threadIdsEquivalent(local, bare)).toBe(true);
    expect(appServerThreadIdCandidates(local)[0]).toBe(bare);
    expect(appServerThreadIdCandidates(local)).toEqual([bare]);
    expect(toDomTurnKey('abc')).toBe('history-content:turn:abc');
    expect(toDomTurnKey('history-content:turn:abc')).toBe('history-content:turn:abc');

    const temp = `${TEMP_THREAD_ID_PREFIX}deadbeef`;
    expect(isTemporaryDesktopThreadId(temp)).toBe(true);
    expect(toAppServerThreadId(temp)).toBeNull();
    expect(appServerThreadIdCandidates(temp)).toEqual([]);
  });

  it('mergeThreadLists overlays CDP pinned/selected/project onto app-server rows', async () => {
    const { mergeThreadLists } = await import('../../src/core/chatgpt-desktop/facade.js');
    const merged = mergeThreadLists(
      {
        backend: 'app-server',
        limit: 10,
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'from app-server',
            pinned: false,
            selected: false,
            kind: 'codex',
          },
        ],
      },
      {
        backend: 'cdp',
        limit: 10,
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'sidebar title',
            pinned: true,
            selected: true,
            kind: 'local',
            project: 'Launch',
          },
          {
            threadId: 'local:client-new-thread:temp',
            title: 'draft',
            pinned: false,
            selected: true,
            kind: 'local',
          },
        ],
      },
    );
    expect(merged.backend).toBe('app-server');
    expect(merged.threads[0]).toMatchObject({
      threadId: 'local:11111111-1111-1111-1111-111111111111',
      title: 'from app-server',
      pinned: true,
      selected: true,
      kind: 'local',
      project: 'Launch',
    });
    expect(merged.threads.some((t) => t.threadId === 'local:client-new-thread:temp')).toBe(true);
  });
});

describe('chatgpt-desktop MCP tools', () => {
  it('registers the chatgpt_desktop_* tools on the grok-bot server', async () => {
    const surface = await listMcpSurface({ server: 'grok-bot' });
    for (const name of desktopTools) {
      expect(surface.tools.includes(name)).toBe(true);
    }
  });

  it('status / list / read / send / wait_reply use the injected adapter', async () => {
    setChatGptDesktopAdapterForTests(fakeAdapter());

    const status = await invokeMcpTool('chatgpt_desktop_status', {
      server: 'grok-bot',
      input: {},
    });
    expect(status.isError).toBe(false);
    expect(status.structuredContent).toMatchObject({
      reachable: true,
      host: '127.0.0.1',
      exitCode: 0,
    });

    const listed = await invokeMcpTool('chatgpt_desktop_list_threads', {
      server: 'grok-bot',
      input: { limit: 10 },
    });
    expect(listed.isError).toBe(false);
    expect(listed.structuredContent).toMatchObject({
      backend: 'cdp',
      exitCode: 0,
      threads: [{ threadId: 'local:11111111-1111-1111-1111-111111111111' }],
    });

    const read = await invokeMcpTool('chatgpt_desktop_read_thread', {
      server: 'grok-bot',
      input: { threadId: 'local:11111111-1111-1111-1111-111111111111' },
    });
    expect(read.isError).toBe(false);
    expect(read.structuredContent).toMatchObject({
      backend: 'cdp',
      full: false,
      turns: [{ role: 'assistant', userText: 'hello', assistantText: 'hi there' }],
    });

    const sent = await invokeMcpTool('chatgpt_desktop_send', {
      server: 'grok-bot',
      input: { text: 'ping', project: 'Launch' },
    });
    expect(sent.isError).toBe(false);
    expect(sent.structuredContent).toMatchObject({
      delivery: 'accepted',
      backend: 'cdp',
      experimental: false,
      temporaryThreadId: 'local:client-new-thread:deadbeef',
      project: 'Launch',
      exitCode: 0,
    });

    const waited = await invokeMcpTool('chatgpt_desktop_wait_reply', {
      server: 'grok-bot',
      input: { threadId: 'local:client-new-thread:deadbeef', timeoutMs: 1000 },
    });
    expect(waited.isError).toBe(false);
    expect(waited.structuredContent).toMatchObject({
      delivery: 'replied',
      reply: 'hi there',
      conversationId: 'conv-real-id',
      exitCode: 0,
    });
  });

  it('maps NotImplementedError to a rejected not-implemented document', async () => {
    setChatGptDesktopAdapterForTests(
      fakeAdapter({
        async listThreads() {
          throw new NotImplementedError('listThreads', 'DOM selectors pending');
        },
      }),
    );
    const result = await invokeMcpTool('chatgpt_desktop_list_threads', {
      server: 'grok-bot',
      input: {},
    });
    expect(result.structuredContent).toMatchObject({
      delivery: 'rejected',
      reason: 'not-implemented',
      code: 'NOT_IMPLEMENTED',
      exitCode: 1,
    });
    const errorText =
      result.structuredContent &&
      typeof result.structuredContent === 'object' &&
      'error' in result.structuredContent
        ? String((result.structuredContent as { error?: unknown }).error ?? '')
        : '';
    expect(errorText).toMatch(/listThreads/);
  });
});

describe('chatgpt-desktop CLI', () => {
  it('dispatches status|threads|read|send through the fake adapter', async () => {
    setChatGptDesktopAdapterForTests(fakeAdapter());

    const status = await invokeCli(['chatgpt-desktop', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    expect(status.value).toMatchObject({ reachable: true, host: '127.0.0.1' });

    const threads = await invokeCli(['chatgpt-desktop', 'threads', '--limit', '5', '--json']);
    expect(threads.exitCode).toBe(0);
    expect(threads.value).toMatchObject({ backend: 'cdp' });

    const read = await invokeCli([
      'chatgpt-desktop',
      'read',
      'local:11111111-1111-1111-1111-111111111111',
      '--json',
    ]);
    expect(read.exitCode).toBe(0);
    expect(read.value).toMatchObject({ backend: 'cdp' });

    const sent = await invokeCli([
      'chatgpt-desktop',
      'send',
      '--thread-id',
      'local:11111111-1111-1111-1111-111111111111',
      'hello from cli',
      '--json',
    ]);
    expect(sent.exitCode).toBe(0);
    expect(sent.value).toMatchObject({ delivery: 'accepted', backend: 'cdp' });
  });

  it('maps CLI NotImplemented failures onto exitCode 1', async () => {
    setChatGptDesktopAdapterForTests(
      fakeAdapter({
        async readThread() {
          throw new NotImplementedError('readThread');
        },
      }),
    );
    const read = await invokeCli([
      'chatgpt-desktop',
      'read',
      'local:missing',
      '--json',
    ]);
    expect(read.exitCode).toBe(1);
    expect(read.value).toMatchObject({
      reason: 'not-implemented',
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('chatgpt-desktop app-server list/read/search + CDP-only send/wait', () => {
  const appFallbacks = (calls: string[]) => ({
    listThreads: async ({ limit = 50 } = {}) => {
      calls.push('app-server.listThreads');
      return {
        backend: 'app-server' as const,
        limit,
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'from app-server',
            pinned: false,
            selected: false,
            kind: 'codex',
            section: { id: 'Pinned', name: 'Pinned' },
            modelProvider: 'openai',
          },
        ],
      };
    },
    searchThreads: async ({ query, limit = 50 }: { query: string; limit?: number }) => {
      calls.push('app-server.searchThreads');
      return {
        backend: 'app-server' as const,
        limit,
        query,
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'from app-server',
            pinned: true,
            selected: false,
            kind: 'codex',
          },
        ],
      };
    },
    readThread: async ({ threadId, limit = 100, full = false }: { threadId: string; limit?: number; full?: boolean }) => {
      calls.push('app-server.readThread');
      return {
        threadId,
        backend: 'app-server' as const,
        limit,
        full,
        turns: [
          { turnKey: 'history-content:turn:t1', role: 'user' as const, text: 'hello' },
          { turnKey: 'history-content:turn:t2', role: 'assistant' as const, text: 'deep history' },
        ],
      };
    },
    statusProbe: async () => ({ reachable: true, mode: 'daemon', socketPath: '/tmp/fake.sock' }),
  });

  it('lists/searches/reads via app-server (merged with CDP), keeps send/wait/open on CDP', async () => {
    const calls: string[] = [];
    const cdp = fakeAdapter({
      async connect() {
        calls.push('cdp.connect');
      },
      async listThreads({ limit = 50 } = {}) {
        calls.push('cdp.listThreads');
        return {
          backend: 'cdp',
          limit,
          threads: [
            {
              threadId: 'local:11111111-1111-1111-1111-111111111111',
              title: 'sidebar',
              pinned: true,
              selected: true,
              kind: 'local',
              project: 'Launch',
            },
          ],
        };
      },
      async readThread({ threadId, limit = 100, full = false }) {
        calls.push(`cdp.readThread:${full ? 'full' : 'visible'}`);
        return {
          threadId,
          backend: 'cdp',
          limit,
          full,
          turns: [{ turnKey: 'visible', role: 'assistant' as const, text: 'on screen' }],
        };
      },
      async sendMessage({ threadId, text }) {
        calls.push('cdp.sendMessage');
        return {
          threadId: threadId ?? 'local:client-new-thread:x',
          backend: 'cdp',
          experimental: false,
          delivery: 'accepted' as const,
          message: text,
        };
      },
      async waitForReply({ threadId }) {
        calls.push('cdp.waitForReply');
        return {
          threadId: threadId ?? 'unknown',
          reply: 'ok',
          backend: 'cdp',
          experimental: false,
          delivery: 'replied' as const,
        };
      },
      async openThread(threadId) {
        calls.push('cdp.openThread');
        return { threadId, backend: 'cdp' as const };
      },
      async status() {
        return {
          reachable: true,
          port: 9222,
          host: '127.0.0.1' as const,
          message: 'ok',
          exitCode: 0 as const,
        };
      },
    });

    const facade = new ChatGptDesktopFacade(cdp, 9222, appFallbacks(calls));

    const listed = await facade.listThreads({ limit: 5 });
    expect(listed).toMatchObject({
      backend: 'app-server',
      threads: [
        {
          threadId: 'local:11111111-1111-1111-1111-111111111111',
          title: 'from app-server',
          selected: true,
          project: 'Launch',
        },
      ],
    });

    const searched = await facade.searchThreads({ query: 'app-server', limit: 5 });
    expect(searched).toMatchObject({
      backend: 'app-server',
      query: 'app-server',
      threads: [{ selected: true, project: 'Launch' }],
    });

    // App-server is primary for every durable read (no visible-first CDP hop).
    const deep = await facade.readThread({
      threadId: 'local:11111111-1111-1111-1111-111111111111',
      limit: 100,
    });
    expect(deep).toMatchObject({
      backend: 'app-server',
      turns: [
        { turnKey: 'history-content:turn:t1', text: 'hello' },
        { turnKey: 'history-content:turn:t2', text: 'deep history' },
      ],
    });

    const full = await facade.readThread({
      threadId: 'local:11111111-1111-1111-1111-111111111111',
      full: true,
    });
    expect(full.backend).toBe('app-server');

    const sent = await facade.sendMessage({ threadId: 'local:11111111-1111-1111-1111-111111111111', text: 'hi' });
    expect(sent).toMatchObject({ backend: 'cdp', delivery: 'accepted' });

    const waited = await facade.waitForReply({ threadId: 'local:11111111-1111-1111-1111-111111111111' });
    expect(waited).toMatchObject({ backend: 'cdp', delivery: 'replied' });

    const opened = await facade.openThread('local:11111111-1111-1111-1111-111111111111');
    expect(opened).toMatchObject({ backend: 'cdp' });

    expect(calls).toEqual([
      'app-server.listThreads',
      'cdp.connect',
      'cdp.listThreads',
      'app-server.searchThreads',
      'cdp.listThreads',
      'app-server.readThread',
      'app-server.readThread',
      'cdp.sendMessage',
      'cdp.waitForReply',
      'cdp.openThread',
    ]);
  });

  it('falls back to CDP read when app-server is unavailable', async () => {
    const calls: string[] = [];
    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {
          calls.push('cdp.connect');
        },
        async readThread({ threadId, limit = 100, full = false }) {
          calls.push(`cdp.readThread:${full ? 'full' : 'visible'}`);
          return {
            threadId,
            backend: 'cdp',
            limit,
            full,
            turns: [{ turnKey: 'w', role: 'assistant', text: 'from wheel' }],
          };
        },
      }),
      9222,
      {
        listThreads: async () => ({ backend: 'app-server', limit: 1, threads: [] }),
        searchThreads: async () => ({ backend: 'app-server', limit: 1, query: '', threads: [] }),
        readThread: async () => {
          calls.push('app-server.readThread');
          throw new Error('unknown thread');
        },
        statusProbe: async () => ({ reachable: false }),
      },
    );

    const read = await facade.readThread({
      threadId: 'local:11111111-1111-1111-1111-111111111111',
      full: true,
    });
    expect(read).toMatchObject({ backend: 'cdp', turns: [{ text: 'from wheel' }] });
    expect(calls).toEqual(['app-server.readThread', 'cdp.connect', 'cdp.readThread:full']);
  });

  it('does not fall back send/wait to app-server when CDP is down', async () => {
    const unreachable = new CdpUnreachableError('CDP down');
    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {
          throw unreachable;
        },
        async sendMessage() {
          throw unreachable;
        },
        async waitForReply() {
          throw unreachable;
        },
        async status() {
          return {
            reachable: false,
            port: 9222,
            host: '127.0.0.1',
            message: 'CDP down',
            exitCode: 1,
          };
        },
      }),
      9222,
      {
        listThreads: async ({ limit = 50 } = {}) => ({
          backend: 'app-server',
          limit,
          threads: [
            {
              threadId: 'local:codex-1',
              title: 'from app-server',
              pinned: false,
              selected: false,
              kind: 'codex',
            },
          ],
        }),
        searchThreads: async ({ query, limit = 50 }) => ({
          backend: 'app-server',
          limit,
          query,
          threads: [],
        }),
        readThread: async ({ threadId, limit = 100, full = false }) => ({
          threadId,
          backend: 'app-server',
          limit,
          full,
          turns: [{ turnKey: 't1', role: 'assistant', text: 'fallback reply' }],
        }),
        statusProbe: async () => ({ reachable: true, mode: 'daemon', socketPath: '/tmp/fake.sock' }),
      },
    );

    const listed = await facade.listThreads({ limit: 5 });
    expect(listed).toMatchObject({ backend: 'app-server', threads: [{ threadId: 'local:codex-1' }] });

    const read = await facade.readThread({ threadId: 'local:codex-1', full: true });
    expect(read).toMatchObject({ backend: 'app-server', turns: [{ text: 'fallback reply' }] });

    await expect(facade.sendMessage({ threadId: 'local:codex-1', text: 'hi' })).rejects.toBeInstanceOf(
      CdpUnreachableError,
    );
    await expect(facade.waitForReply({ threadId: 'local:codex-1' })).rejects.toBeInstanceOf(
      CdpUnreachableError,
    );

    const status = await facade.status();
    expect(status).toMatchObject({
      reachable: true,
      appServerFallback: { reachable: true, mode: 'daemon' },
      message: 'CDP unreachable; Codex app-server available for list/search/read',
      exitCode: 0,
    });
  });

  it('keeps app-server list when CDP merge hits NotImplemented', async () => {
    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {},
        async listThreads() {
          throw new NotImplementedError('listThreads');
        },
      }),
      9222,
      {
        listThreads: async ({ limit = 50 } = {}) => ({
          backend: 'app-server',
          limit,
          threads: [
            {
              threadId: 'local:codex-1',
              title: 'from app-server',
              pinned: false,
              selected: false,
              kind: 'codex',
            },
          ],
        }),
        searchThreads: async () => ({ backend: 'app-server', limit: 1, query: '', threads: [] }),
        readThread: async () => {
          throw new Error('unused');
        },
        statusProbe: async () => ({ reachable: false }),
      },
    );
    const listed = await facade.listThreads();
    expect(listed).toMatchObject({
      backend: 'app-server',
      threads: [{ threadId: 'local:codex-1' }],
    });
  });

  it('surfaces RemoteThreadNotLoadedError with hostId from global state', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { RemoteThreadNotLoadedError, findRemoteThreadHostId } = await import(
      '../../src/core/chatgpt-desktop/index.js'
    );
    const home = mkdtempSync(join(tmpdir(), 'gbot-remote-'));
    writeFileSync(
      join(home, '.codex-global-state.json'),
      JSON.stringify({
        'remote-thread-summaries-v3:host-abc': [{ id: 'remote-thread-1' }],
      }),
    );
    expect(findRemoteThreadHostId('remote-thread-1', { CODEX_HOME: home })).toBe('host-abc');
    expect(findRemoteThreadHostId('local:remote-thread-1', { CODEX_HOME: home })).toBe('host-abc');
    const err = new RemoteThreadNotLoadedError('remote-thread-1', 'host-abc');
    expect(err.code).toBe('REMOTE_THREAD_NOT_LOADED');
    expect(err.hostId).toBe('host-abc');
    expect(err.message).toMatch(/host-abc/);
  });
});

describe('chatgpt-desktop CDP HTTP status probe', () => {
  it('reports reachable when /json/version answers on loopback', async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            Browser: 'Test/1',
            'Protocol-Version': '1.3',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/browser/test',
          }),
        );
        return;
      }
      if (req.url === '/json/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ id: '1', type: 'page', url: 'app://-/index.html' }]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const { CdpChatGptDesktopAdapter } = await import(
        '../../src/core/chatgpt-desktop/cdp-adapter.js'
      );
      const adapter = new CdpChatGptDesktopAdapter();
      // connect sets the port then fails on WebSocket; status still uses /json/version.
      await expect(adapter.connect({ port })).rejects.toThrow(/CDP|WebSocket|ECONNREFUSED|failed/i);
      const status = await adapter.status();
      expect(status).toMatchObject({
        reachable: true,
        port,
        host: '127.0.0.1',
        browser: 'Test/1',
        targetCount: 1,
        exitCode: 0,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
