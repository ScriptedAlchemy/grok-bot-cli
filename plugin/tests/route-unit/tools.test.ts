import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@rstest/core';
import { invokeMcpTool, listMcpSurface } from 'agent-bundle/test';

/**
 * The tools run the real `gbot` gateway client against a loopback fake
 * gateway selected through the client's own env override
 * (`GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN`), so no request leaves
 * the machine and the developer's Grok Bot app session is never read.
 */
interface GatewayCall {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly method: string;
}

const roster = {
  agents: [
    { id: 'bot-1', isGroup: false, name: 'General' },
    { id: 'grp-1', memberAgentIds: ['bot-1'], name: 'Launch' },
    { id: 'bot-2', isGroup: false, name: 'Legacy' },
    { id: 'bot-3', isGroup: false, name: 'Proxy' },
  ],
};
const transcripts: Record<string, unknown> = {
  'bot-1': { entries: [], nextBeforeSeq: 0 },
  'bot-2': {
    messages: [
      { content: 'ignored when text is set', id: 'l1', text: 'direct text' },
      { content: [{ text: 'part one' }, 'part two', { content: 'part three' }], id: 'l2', kind: 'note' },
      { id: 'l3', message: 'plain message' },
      { id: 'l4', kind: 'message', text: `${'x'.repeat(450)}` },
    ],
  },
  'grp-1': {
    entries: [
      { content: 'hello from the test', id: 't1', kind: 'message', role: 'user', timestampMs: 1 },
      { id: 't2', kind: 'send-message', message: { content: 'reply', type: 'text' } },
      { id: 't3', kind: 'tool-call' },
    ],
    nextBeforeSeq: 9,
  },
};
const responses: Record<string, (body: Record<string, unknown>) => [number, unknown]> = {
  getAgentTranscriptTail: (body) => [200, transcripts[String(body.id)]],
  listAgents: () => [200, roster],
  sendPrompt: (body) =>
    body.agentId === 'bot-3'
      ? [401, { message: 'upstream rejected authorization: Bearer test-token' }]
      : [200, { messageId: 'm-1' }],
};

const calls: GatewayCall[] = [];
let server: Server;
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ['GROK_BOT_GATEWAY_URL', 'GROK_BOT_GATEWAY_TOKEN', 'GROK_BOT_ALLOW_LOCAL_GATEWAY'];

const contentText = (content: readonly { readonly text?: string }[]): string =>
  content.map((block) => block.text ?? '').join('\n');

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => resolve(text));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const method = (req.url ?? '').replace(/^\/api\//u, '');
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    calls.push({ authorization: req.headers.authorization, body, method });
    const [status, payload] = responses[method]?.(body) ?? [404, { error: 'unknown method ' + method }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  for (const key of envKeys) savedEnv[key] = process.env[key];
  process.env.GROK_BOT_GATEWAY_URL = `http://127.0.0.1:${port}`;
  process.env.GROK_BOT_GATEWAY_TOKEN = 'test-token';
  process.env.GROK_BOT_ALLOW_LOCAL_GATEWAY = '1';
});

afterAll(async () => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  calls.length = 0;
});

describe('grok-bot MCP server', () => {
  it('registers exactly the two gbot tools', async () => {
    const surface = await listMcpSurface({ server: 'grok-bot' });
    expect([...surface.tools].sort()).toEqual(['gbot_send', 'gbot_thread']);
  });

  it('gbot_send resolves the target by name and posts the prompt with the gateway token', async () => {
    const result = await invokeMcpTool('gbot_send', {
      input: { message: 'automated smoke', target: 'general' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      result: { messageId: 'm-1' },
      target: { id: 'bot-1', kind: 'bot', name: 'General' },
    });
    expect(calls.map((call) => call.method)).toEqual(['listAgents', 'sendPrompt']);
    expect(calls[1]).toMatchObject({
      authorization: 'Bearer test-token',
      body: { agentId: 'bot-1', prompt: 'automated smoke' },
    });
    expect(calls[1]?.body.clientNonce).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('gbot_thread normalizes user and bot entries and forwards the limit', async () => {
    const result = await invokeMcpTool('gbot_thread', {
      input: { limit: 3, target: 'Launch' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      entries: [
        { id: 't1', kind: 'message', role: 'user', text: 'hello from the test', timestampMs: 1 },
        { id: 't2', kind: 'send-message', text: 'reply' },
        { id: 't3', kind: 'tool-call', text: '' },
      ],
      target: { id: 'grp-1', kind: 'group', name: 'Launch' },
    });
    expect(calls[1]).toMatchObject({ body: { id: 'grp-1', limit: 3 }, method: 'getAgentTranscriptTail' });
    expect(contentText(result.content)).toContain('[user] hello from the test');
    expect(contentText(result.content)).toContain('[send-message] reply');
  });

  it('gbot_thread defaults the limit to 40 like the CLI and reads the other transcript shapes', async () => {
    const empty = await invokeMcpTool('gbot_thread', { input: { target: 'General' }, server: 'grok-bot' });
    expect(calls[1]?.body).toEqual({ id: 'bot-1', limit: 40 });
    expect(empty.structuredContent).toEqual({ entries: [], target: { id: 'bot-1', kind: 'bot', name: 'General' } });

    const legacy = await invokeMcpTool('gbot_thread', { input: { target: 'Legacy' }, server: 'grok-bot' });
    expect(legacy.structuredContent).toMatchObject({
      entries: [
        { id: 'l1', kind: 'message', text: 'direct text' },
        { id: 'l2', kind: 'note', text: 'part one\npart two\npart three' },
        { id: 'l3', kind: 'message', text: 'plain message' },
        { id: 'l4', kind: 'message', text: `${'x'.repeat(399)}…` },
      ],
    });
    expect(contentText(legacy.content)).toContain('…');
    expect(contentText(legacy.content)).not.toContain('x'.repeat(450));
  });

  it('redacts a bearer token echoed by the gateway before the error reaches the host', async () => {
    const result = await invokeMcpTool('gbot_send', {
      input: { message: 'x', target: 'Proxy' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(true);
    const text = contentText(result.content);
    expect(text).toContain('sendPrompt failed: 401');
    expect(text).toContain('<redacted>');
    expect(text).not.toContain('test-token');
  });

  it('surfaces an unknown target as a tool error without sending anything', async () => {
    const result = await invokeMcpTool('gbot_send', {
      input: { message: 'x', target: 'Nobody' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(true);
    expect(contentText(result.content)).toContain('No bot or group named "Nobody"');
    expect(calls.map((call) => call.method)).toEqual(['listAgents']);
  });
});
