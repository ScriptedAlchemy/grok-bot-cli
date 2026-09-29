import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from '@rstest/core';
import { invokeCli, invokeMcpTool, listMcpSurface } from 'agent-bundle/test';

import type { ChatGptDesktopAdapter } from '../../src/core/chatgpt-desktop/adapter.js';
import {
  CdpHostRejectedError,
  NotImplementedError,
  assertLoopbackHostname,
  chatgptDesktopRelaunchCommand,
  forceLoopbackWebSocketUrl,
  setChatGptDesktopAdapterForTests,
} from '../../src/core/chatgpt-desktop/index.js';

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
    async readThread({ threadId, limit = 100 }) {
      return {
        threadId,
        backend: 'cdp',
        limit,
        turns: [
          { turnKey: 'u1', role: 'user', text: 'hello' },
          { turnKey: 'a1', role: 'assistant', text: 'hi there' },
        ],
      };
    },
    async sendMessage({ threadId, text }) {
      return {
        threadId: threadId ?? 'new',
        backend: 'cdp',
        experimental: true,
        delivery: 'accepted',
        message: text,
      };
    },
    async waitForReply({ threadId }) {
      return {
        threadId,
        reply: 'hi there',
        backend: 'cdp',
        experimental: true,
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
      turns: [{ role: 'user' }, { role: 'assistant' }],
    });

    const sent = await invokeMcpTool('chatgpt_desktop_send', {
      server: 'grok-bot',
      input: { text: 'ping' },
    });
    expect(sent.isError).toBe(false);
    expect(sent.structuredContent).toMatchObject({
      delivery: 'accepted',
      backend: 'cdp',
      experimental: true,
      exitCode: 0,
    });

    const waited = await invokeMcpTool('chatgpt_desktop_wait_reply', {
      server: 'grok-bot',
      input: { threadId: 'local:11111111-1111-1111-1111-111111111111', timeoutMs: 1000 },
    });
    expect(waited.isError).toBe(false);
    expect(waited.structuredContent).toMatchObject({
      delivery: 'replied',
      reply: 'hi there',
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
