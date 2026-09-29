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

describe('chatgpt-desktop MCP tools', () => {
  it('registers the five chatgpt_desktop_* tools on the grok-bot server', async () => {
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

describe('chatgpt-desktop CDP→app-server fallback', () => {
  it('prefers CDP, then reuses app-server fallbacks with backend tagging', async () => {
    const calls: string[] = [];
    const unreachable = new CdpUnreachableError('CDP down');
    const cdp = fakeAdapter({
      async connect() {
        calls.push('cdp.connect');
        throw unreachable;
      },
      async listThreads() {
        calls.push('cdp.listThreads');
        throw unreachable;
      },
      async readThread() {
        calls.push('cdp.readThread');
        throw unreachable;
      },
      async sendMessage() {
        calls.push('cdp.sendMessage');
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
    });

    const facade = new ChatGptDesktopFacade(cdp, 9222, {
      listThreads: async ({ limit = 50 } = {}) => {
        calls.push('app-server.listThreads');
        return {
          backend: 'app-server',
          limit,
          threads: [
            {
              threadId: 'codex-1',
              title: 'from app-server',
              pinned: false,
              selected: false,
              kind: 'codex',
            },
          ],
        };
      },
      readThread: async ({ threadId, limit = 100, full = false }) => {
        calls.push('app-server.readThread');
        return {
          threadId,
          backend: 'app-server',
          limit,
          full,
          turns: [{ turnKey: 't1', role: 'assistant', text: 'fallback reply' }],
        };
      },
      sendMessage: async ({ threadId, text }) => {
        calls.push('app-server.sendMessage');
        return {
          threadId: threadId ?? 'missing',
          backend: 'app-server',
          experimental: false,
          delivery: 'accepted',
          message: text,
        };
      },
      waitForReply: async ({ threadId }) => ({
        threadId: threadId ?? 'codex-1',
        reply: 'fallback reply',
        backend: 'app-server',
        experimental: false,
        delivery: 'replied' as const,
      }),
      openThread: async (threadId) => ({ threadId, backend: 'app-server' as const }),
      statusProbe: async () => ({ reachable: true, mode: 'daemon', socketPath: '/tmp/fake.sock' }),
    });

    const listed = await facade.listThreads({ limit: 5 });
    expect(listed).toMatchObject({ backend: 'app-server', threads: [{ threadId: 'codex-1' }] });

    const read = await facade.readThread({ threadId: 'codex-1' });
    expect(read).toMatchObject({ backend: 'app-server', turns: [{ text: 'fallback reply' }] });

    const sent = await facade.sendMessage({ threadId: 'codex-1', text: 'hi' });
    expect(sent).toMatchObject({ backend: 'app-server', delivery: 'accepted' });

    const status = await facade.status();
    expect(status).toMatchObject({
      reachable: true,
      appServerFallback: { reachable: true, mode: 'daemon' },
      message: 'CDP unreachable; Codex app-server fallback is available',
      exitCode: 0,
    });

    expect(calls.filter((c) => c.startsWith('app-server'))).toEqual([
      'app-server.listThreads',
      'app-server.readThread',
      'app-server.sendMessage',
    ]);
    expect(calls.some((c) => c.startsWith('cdp.'))).toBe(true);
  });

  it('does not fall back for NotImplemented DOM gaps', async () => {
    const facade = new ChatGptDesktopFacade(
      fakeAdapter({
        async connect() {},
        async listThreads() {
          throw new NotImplementedError('listThreads');
        },
      }),
      9222,
      {
        listThreads: async () => {
          throw new Error('app-server should not run');
        },
        readThread: async () => {
          throw new Error('unused');
        },
        sendMessage: async () => {
          throw new Error('unused');
        },
        waitForReply: async () => {
          throw new Error('unused');
        },
        openThread: async () => {
          throw new Error('unused');
        },
        statusProbe: async () => ({ reachable: false }),
      },
    );
    await expect(facade.listThreads()).rejects.toBeInstanceOf(NotImplementedError);
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
