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
  'chatgpt_desktop_list_hosts',
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
        backend: 'cdp' as const,
        limit,
        host: 'all',
        threads: [
          {
            threadId: 'local:11111111-1111-1111-1111-111111111111',
            title: 'Scaffold thread',
            pinned: false,
            selected: true,
            kind: 'local',
            location: 'local' as const,
            hostId: null,
            hostName: null,
          },
        ].slice(0, limit),
      };
    },
    async listHosts() {
      // Stub only — production discovery is dynamic (see listDiscoveredHosts /
      // chatgpt_desktop_list_hosts). Do not treat these ids as an allowlist.
      return {
        backend: 'app-server' as const,
        hostsSource: 'remote-thread-summaries-v3+local',
        modelProviders: ['fixture-provider'],
        modelProvidersSource: 'thread/list-distinct',
        hosts: [
          { hostId: 'local', hostName: 'local', location: 'local' as const, threadCount: 1 },
          {
            hostId: 'fixture-remote-a',
            hostName: 'Fixture Remote A',
            location: 'remote' as const,
            threadCount: 2,
          },
        ],
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
        threadId: threadId && !threadId.startsWith('local:client-new-thread:')
          ? threadId
          : 'local:11111111-1111-1111-1111-111111111111',
        temporaryThreadId: threadId ? undefined : 'local:client-new-thread:deadbeef',
        conversationId: '11111111-1111-1111-1111-111111111111',
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
        threadId: 'local:conv-real-id',
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
        { threadId: 'local:c', title: 'c-desktop', pinned: false, selected: false, kind: 'local' },
        { threadId: 'c', title: 'c-bare', pinned: true, selected: false, kind: 'local' },
      ]).map((t) => ({ id: t.threadId, pinned: t.pinned, selected: t.selected })),
    ).toEqual([
      { id: 'a', pinned: false, selected: true },
      { id: 'b', pinned: false, selected: false },
      { id: 'c', pinned: true, selected: false },
    ]);

    const targets = summarizeTargetInfos([
      { targetId: 'overlay', type: 'page', url: 'app://-/index.html?initialRoute=%2Favatar-overlay' },
      { targetId: 'web', type: 'page', url: 'https://chatgpt.com/pricing' },
      { targetId: 'main', type: 'page', title: 'ChatGPT', url: MAIN_WINDOW_URL },
    ]);
    // Exact URL wins regardless of /json/list-style order (overlay/web listed first).
    expect(pickMainWindowTarget(targets)?.targetId).toBe('main');
    expect(pickMainWindowTarget(targets.slice().reverse())?.targetId).toBe('main');
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

    const hosts = await invokeMcpTool('chatgpt_desktop_list_hosts', {
      server: 'grok-bot',
      input: {},
    });
    expect(hosts.isError).toBe(false);
    expect(hosts.structuredContent).toMatchObject({
      exitCode: 0,
      hostsSource: 'remote-thread-summaries-v3+local',
      modelProvidersSource: 'thread/list-distinct',
      modelProviders: ['fixture-provider'],
      hosts: [
        { hostId: 'local', location: 'local' },
        { hostId: 'fixture-remote-a', hostName: 'Fixture Remote A' },
      ],
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
      threadId: 'local:11111111-1111-1111-1111-111111111111',
      temporaryThreadId: 'local:client-new-thread:deadbeef',
      conversationId: '11111111-1111-1111-1111-111111111111',
      project: 'Launch',
      exitCode: 0,
    });
    expect(String((sent.structuredContent as { threadId?: string }).threadId ?? '')).not.toMatch(
      /^local:client-new-thread:/,
    );

    const waited = await invokeMcpTool('chatgpt_desktop_wait_reply', {
      server: 'grok-bot',
      input: { threadId: 'local:client-new-thread:deadbeef', timeoutMs: 1000 },
    });
    expect(waited.isError).toBe(false);
    expect(waited.structuredContent).toMatchObject({
      delivery: 'replied',
      reply: 'hi there',
      conversationId: 'conv-real-id',
      threadId: 'local:conv-real-id',
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
  it('dispatches status|hosts|threads|read|send through the fake adapter', async () => {
    setChatGptDesktopAdapterForTests(fakeAdapter());

    const status = await invokeCli(['chatgpt-desktop', 'status', '--json']);
    expect(status.exitCode).toBe(0);
    expect(status.value).toMatchObject({ reachable: true, host: '127.0.0.1' });

    const hosts = await invokeCli(['chatgpt-desktop', 'hosts', '--json']);
    expect(hosts.exitCode).toBe(0);
    expect(hosts.value).toMatchObject({
      hostsSource: 'remote-thread-summaries-v3+local',
      modelProvidersSource: 'thread/list-distinct',
    });

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
    listRemoteThreads: () => [],
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
          threadId: threadId && !threadId.startsWith('local:client-new-thread:')
            ? threadId
            : 'local:resolved-after-send',
          temporaryThreadId: threadId ? undefined : 'local:client-new-thread:x',
          conversationId: 'resolved-after-send',
          backend: 'cdp',
          experimental: false,
          delivery: 'accepted' as const,
          message: text,
        };
      },
      async waitForReply({ threadId }) {
        calls.push('cdp.waitForReply');
        return {
          threadId: threadId && !threadId.startsWith('local:client-new-thread:')
            ? threadId
            : 'local:resolved-after-send',
          conversationId: 'resolved-after-send',
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

  it('merges remote-control summaries from the global-state fixture', async () => {
    const { copyFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const {
      finalizeThreadList,
      findRemoteThread,
      listRemoteThreadsFromState,
      RemoteThreadNotLoadedError,
    } = await import('../../src/core/chatgpt-desktop/index.js');

    const home = mkdtempSync(join(tmpdir(), 'gbot-remote-fix-'));
    copyFileSync(
      join(process.cwd(), 'tests/fixtures/codex-global-state-remote.json'),
      join(home, '.codex-global-state.json'),
    );
    const env = { CODEX_HOME: home };
    const remotes = listRemoteThreadsFromState(env);
    expect(remotes.map((t) => t.threadId).sort()).toEqual([
      'local:aaaa1111-1111-1111-1111-111111111111',
      'local:bbbb2222-2222-2222-2222-222222222222',
      'local:cccc3333-3333-3333-3333-333333333333',
      'local:dddd4444-4444-4444-4444-444444444444',
    ]);
    const pinned = remotes.find((t) => t.threadId.includes('aaaa1111'));
    expect(pinned).toMatchObject({
      location: 'remote',
      hostId: 'host-macbook',
      hostName: "Zack's MacBook",
      pinned: true,
      project: 'Launch',
      projectId: 'proj-launch',
    });
    const linux = remotes.find((t) => t.threadId.includes('cccc3333'));
    expect(linux).toMatchObject({
      location: 'remote',
      hostId: 'host-linux',
      hostName: 'build-box',
      project: 'Infra',
    });

    const listed = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [
          {
            threadId: 'local:local-thread-1',
            title: 'Local only',
            pinned: false,
            selected: true,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
          },
        ],
      },
      { limit: 50, remotes, groupBy: 'host' },
    );
    expect(listed.threads.some((t) => t.location === 'local')).toBe(true);
    expect(listed.threads.some((t) => t.location === 'remote')).toBe(true);
    expect(listed.groups?.map((g) => g.hostId).sort()).toEqual([
      'broken-host',
      'host-linux',
      'host-macbook',
      'local',
    ]);

    const filtered = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [
          {
            threadId: 'local:local-thread-1',
            title: 'Local only',
            pinned: false,
            selected: false,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
          },
        ],
      },
      { limit: 50, remotes, host: 'macbook' },
    );
    expect(filtered.host).toBe('macbook');
    expect(filtered.threads.every((t) => t.hostId === 'host-macbook')).toBe(true);

    const localOnly = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [
          {
            threadId: 'local:local-thread-1',
            title: 'Local only',
            pinned: false,
            selected: false,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
            modelProvider: 'openai',
          },
        ],
      },
      { limit: 50, remotes, host: 'local' },
    );
    expect(localOnly.threads).toHaveLength(1);
    expect(localOnly.threads[0]?.location).toBe('local');

    const byProvider = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [
          {
            threadId: 'local:local-thread-1',
            title: 'Local only',
            pinned: false,
            selected: false,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
            modelProvider: 'openai',
          },
          {
            threadId: 'local:local-thread-2',
            title: 'Other provider',
            pinned: false,
            selected: false,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
            modelProvider: 'anthropic',
          },
        ],
      },
      { limit: 50, remotes: [], host: 'all', modelProvider: 'openai' },
    );
    expect(byProvider.modelProvider).toBe('openai');
    expect(byProvider.threads).toHaveLength(1);
    expect(byProvider.threads[0]?.modelProvider).toBe('openai');

    const {
      listDiscoveredHosts,
    } = await import('../../src/core/chatgpt-desktop/index.js');
    const discovered = listDiscoveredHosts(env, { localThreadCount: 3 });
    expect(discovered.map((h) => h.hostId)).toEqual([
      'local',
      'broken-host',
      'host-linux',
      'host-macbook',
    ]);
    expect(discovered.find((h) => h.hostId === 'local')?.threadCount).toBe(3);
    expect(discovered.find((h) => h.hostId === 'host-macbook')).toMatchObject({
      hostName: "Zack's MacBook",
      threadCount: 2,
      location: 'remote',
    });

    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {
          throw new CdpUnreachableError('offline');
        },
        async listThreads() {
          throw new CdpUnreachableError('offline');
        },
      }),
      9222,
      {
        listThreads: async ({ limit = 50 } = {}) => ({
          backend: 'app-server' as const,
          limit,
          threads: [
            {
              threadId: 'local:local-1',
              title: 'Local',
              pinned: false,
              selected: false,
              kind: 'codex',
              modelProvider: 'openai',
            },
          ],
        }),
        searchThreads: async () => ({ backend: 'app-server' as const, limit: 1, query: '', threads: [] }),
        readThread: async () => {
          throw new Error('unused');
        },
        statusProbe: async () => ({ reachable: true, mode: 'daemon' }),
        listRemoteThreads: () => remotes,
        discoverModelProviders: async () => ({
          providers: ['openai', 'anthropic'],
          source: 'thread/list-distinct' as const,
        }),
        discoverRemoteEnvironments: async () => ({ hosts: [], source: null }),
      },
    );
    const hostList = await facade.listHosts();
    expect(hostList.hostsSource).toBe('remote-thread-summaries-v3+local');
    expect(hostList.modelProvidersSource).toBe('thread/list-distinct');
    expect(hostList.modelProviders).toEqual(['openai', 'anthropic']);
    expect(hostList.hosts.find((h) => h.hostId === 'local')?.threadCount).toBe(1);
    expect(hostList.hosts.find((h) => h.hostId === 'host-macbook')?.threadCount).toBe(2);

    const lookup = findRemoteThread('aaaa1111-1111-1111-1111-111111111111', env);
    expect(lookup).toMatchObject({ hostId: 'host-macbook', hostName: "Zack's MacBook" });
    const err = new RemoteThreadNotLoadedError(
      'aaaa1111-1111-1111-1111-111111111111',
      lookup?.hostId ?? null,
      lookup?.hostName ?? null,
    );
    expect(err.code).toBe('REMOTE_THREAD_NOT_LOADED');
    expect(err.hostId).toBe('host-macbook');
    expect(err.hostName).toBe("Zack's MacBook");
    expect(err.hint).toMatch(/host-macbook/);
    expect(err.message).toMatch(/app-server/);
  });

  it('discovers an unknown hostId from global-state and filters by it with no code change', async () => {
    const { copyFileSync, mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomUUID } = await import('node:crypto');
    const {
      finalizeThreadList,
      listDiscoveredHosts,
      listRemoteThreadsFromState,
    } = await import('../../src/core/chatgpt-desktop/index.js');

    // Brand-new id never mentioned in source — only injected into the fixture.
    const unknownHostId = `host-supercomputer-${randomUUID().slice(0, 8)}`;
    const unknownFriendly = 'Supercomputer Lab 9000';
    const unknownThreadId = randomUUID();

    const home = mkdtempSync(join(tmpdir(), 'gbot-remote-unknown-'));
    const fixturePath = join(process.cwd(), 'tests/fixtures/codex-global-state-remote.json');
    const statePath = join(home, '.codex-global-state.json');
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const hostsV1 = (base['remote-hosts-v1'] ?? {}) as Record<string, unknown>;
    hostsV1[unknownHostId] = { name: unknownFriendly, envName: 'lab' };
    base['remote-hosts-v1'] = hostsV1;
    base[`remote-thread-summaries-v3:${unknownHostId}`] = {
      hostName: unknownFriendly,
      threads: [
        {
          id: unknownThreadId,
          title: 'Brand new machine thread',
          updatedAt: 1700000999,
          modelProvider: 'brand-new-provider',
        },
      ],
    };
    writeFileSync(statePath, JSON.stringify(base, null, 2));
    // Keep a copy of the stock fixture nearby so the test still proves we
    // started from fixture data and only added the unknown host.
    copyFileSync(fixturePath, join(home, 'stock-fixture.json'));

    const env = { CODEX_HOME: home };
    const remotes = listRemoteThreadsFromState(env);
    expect(remotes.some((t) => t.hostId === unknownHostId)).toBe(true);

    const discovered = listDiscoveredHosts(env, { localThreadCount: 0 });
    expect(discovered.map((h) => h.hostId)).toContain(unknownHostId);
    expect(discovered.find((h) => h.hostId === unknownHostId)).toMatchObject({
      hostId: unknownHostId,
      hostName: unknownFriendly,
      location: 'remote',
      threadCount: 1,
    });

    const filtered = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [
          {
            threadId: 'local:local-thread-1',
            title: 'Local only',
            pinned: false,
            selected: false,
            kind: 'codex',
            location: 'local',
            hostId: null,
            hostName: null,
          },
        ],
      },
      { limit: 50, remotes, host: unknownHostId },
    );
    expect(filtered.host).toBe(unknownHostId);
    expect(filtered.threads.length).toBeGreaterThan(0);
    expect(filtered.threads.every((t) => t.hostId === unknownHostId)).toBe(true);

    const byFriendly = finalizeThreadList(
      {
        backend: 'app-server',
        limit: 50,
        threads: [],
      },
      { limit: 50, remotes, host: 'Supercomputer Lab' },
    );
    expect(byFriendly.threads.every((t) => t.hostId === unknownHostId)).toBe(true);
    expect(byFriendly.threads.length).toBeGreaterThan(0);

    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {
          throw new CdpUnreachableError('offline');
        },
        async listThreads() {
          throw new CdpUnreachableError('offline');
        },
      }),
      9222,
      {
        listThreads: async ({ limit = 50 } = {}) => ({
          backend: 'app-server' as const,
          limit,
          threads: [],
        }),
        searchThreads: async () => ({
          backend: 'app-server' as const,
          limit: 1,
          query: '',
          threads: [],
        }),
        readThread: async () => {
          throw new Error('unused');
        },
        statusProbe: async () => ({ reachable: true, mode: 'daemon' }),
        listRemoteThreads: () => remotes,
        discoverModelProviders: async () => ({
          providers: ['brand-new-provider'],
          source: 'thread/list-distinct' as const,
        }),
        discoverRemoteEnvironments: async () => ({ hosts: [], source: null }),
        listHosts: (processEnv, opts) => listDiscoveredHosts(env, opts),
      },
    );
    const hostList = await facade.listHosts();
    expect(hostList.hosts.some((h) => h.hostId === unknownHostId)).toBe(true);
    expect(hostList.hosts.find((h) => h.hostId === unknownHostId)).toMatchObject({
      hostName: unknownFriendly,
      threadCount: 1,
      location: 'remote',
    });
    expect(hostList.modelProviders).toContain('brand-new-provider');
  });

  it('skips malformed global-state files without throwing', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { listRemoteThreadsFromState } = await import('../../src/core/chatgpt-desktop/index.js');
    const home = mkdtempSync(join(tmpdir(), 'gbot-remote-bad-'));
    writeFileSync(join(home, '.codex-global-state.json'), '{not-json');
    expect(listRemoteThreadsFromState({ CODEX_HOME: home })).toEqual([]);
    writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify(['array']));
    expect(listRemoteThreadsFromState({ CODEX_HOME: home })).toEqual([]);
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

describe('chatgpt-desktop production-risk guards', () => {
  it('never treats local:client-new-thread as a durable send/wait id', async () => {
    const { resolveDurableThreadId, TEMP_THREAD_ID_PREFIX } = await import(
      '../../src/core/chatgpt-desktop/cdp-dom.js'
    );
    expect(resolveDurableThreadId(null, `${TEMP_THREAD_ID_PREFIX}abc`)).toBeNull();
    expect(resolveDurableThreadId(`${TEMP_THREAD_ID_PREFIX}abc`)).toBeNull();
    expect(resolveDurableThreadId('conv-real')).toBe('local:conv-real');
    expect(resolveDurableThreadId('local:conv-real', `${TEMP_THREAD_ID_PREFIX}x`)).toBe(
      'local:conv-real',
    );
  });

  it('loads history with mouseWheel (column-reverse), not scrollTop writes', async () => {
    const {
      FULL_READ_WHEEL_DELTA_Y,
      readTurnsFromDom,
    } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
    expect(FULL_READ_WHEEL_DELTA_Y).toBeLessThan(0);

    const sends: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let evaluateN = 0;
    const session = {
      async evaluate(expression: string) {
        evaluateN += 1;
        if (expression.includes('scrollTop')) {
          return { ok: true, x: 10, y: 20, scrollTop: 0, scrollHeight: 2000, clientHeight: 400 };
        }
        // First harvest: one turn; later harvests idle so wheel loop stops.
        if (evaluateN <= 2) {
          return [{ turnKey: 'history-content:turn:1', role: 'assistant', text: 'hi' }];
        }
        return [{ turnKey: 'history-content:turn:1', role: 'assistant', text: 'hi' }];
      },
      async send(method: string, params?: Record<string, unknown>) {
        sends.push({ method, params });
      },
    };

    const turns = await readTurnsFromDom(session as never, 'sess', {
      full: true,
      limit: 10,
      idleWheels: 2,
      maxWheels: 3,
    });
    expect(turns.length).toBeGreaterThan(0);
    expect(sends.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(
      sends.every(
        (s) =>
          s.method !== 'Input.dispatchMouseEvent'
          || (s.params?.type === 'mouseWheel'
            && s.params?.deltaY === FULL_READ_WHEEL_DELTA_Y
            && !('scrollTop' in (s.params ?? {}))),
      ),
    ).toBe(true);
  });

  it('times out when Loading task… never clears', async () => {
    const { waitForLoadingTaskGone, LOADING_TASK_TEXT } = await import(
      '../../src/core/chatgpt-desktop/cdp-dom.js'
    );
    const session = {
      async evaluate() {
        return false;
      },
    };
    await expect(
      waitForLoadingTaskGone(session as never, 'sess', { timeoutMs: 50 }),
    ).rejects.toThrow(LOADING_TASK_TEXT);
  });

  it('opens sidebar rows for both local: and bare thread ids', async () => {
    const { openThreadExpression } = await import('../../src/core/chatgpt-desktop/cdp-dom.js');
    const expr = openThreadExpression('local:abc-123');
    expect(expr).toContain('local:abc-123');
    expect(expr).toContain('abc-123');
  });
});
