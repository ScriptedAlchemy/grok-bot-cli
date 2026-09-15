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
    { id: 'bot-4', isGroup: false, name: 'Odd' },
    { id: 'bot-5', isGroup: false, name: 'Noreceipt' },
    { id: 'bot-6', isGroup: false, name: 'Big' },
    { id: 'bot-7', isGroup: false, name: 'Meta' },
    { id: 'bot-8', isGroup: false, name: 'Noisy' },
  ],
};
const transcripts: Record<string, unknown> = {
  'bot-1': { entries: [], nextBeforeSeq: 0 },
  'bot-8': {
    entries: Array.from({ length: 60 }, (_, index) => ({
      id: `n${index + 1}`,
      kind: 'message',
      text: `update ${index + 1} ${'y'.repeat(390)}`,
    })),
  },
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
  'bot-4': {
    entries: [
      { content: { text: 5 }, id: 'o1', kind: 'note' },
      { id: 'o2', kind: 'mystery' },
      { id: 'o3', kind: 'note', text: `a${String.fromCharCode(0xd800)}b` },
    ],
  },
  'bot-6': {
    entries: Array.from({ length: 11 }, (_, index) => ({ id: `b${index}`, kind: 'note', text: 'q'.repeat(20000) })),
  },
  'bot-7': {
    entries: [{ id: 'i'.repeat(300), kind: 'k'.repeat(300), role: 'R'.repeat(5000), text: 'hi' }],
  },
};
const responses: Record<string, (body: Record<string, unknown>) => [number, unknown]> = {
  getAgentTranscriptTail: (body) => [200, transcripts[String(body.id)]],
  listAgents: () => [200, roster],
  sendPrompt: (body) =>
    body.agentId === 'bot-3'
      ? [401, { message: 'upstream rejected authorization: Bearer test-token' }]
      : body.agentId === 'bot-5'
        ? [200, { ok: true }]
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
      delivery: 'accepted',
      messageId: 'm-1',
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

  it('gbot_thread returns a short summary plus cursor by default and keeps entry text for full:true', async () => {
    const result = await invokeMcpTool('gbot_thread', {
      input: { limit: 3, target: 'Launch' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      cursor: 't3',
      entries: [
        { id: 't1', kind: 'message', role: 'user', text: 'hello from the test', truncated: false, fullLength: 19, timestampMs: 1 },
        { id: 't2', kind: 'send-message', text: 'reply', truncated: false, fullLength: 5 },
        { id: 't3', kind: 'tool-call', text: '', truncated: false, fullLength: 0 },
      ],
      target: { id: 'grp-1', kind: 'group', name: 'Launch' },
    });
    expect(calls[1]).toMatchObject({ body: { id: 'grp-1', limit: 3 }, method: 'getAgentTranscriptTail' });
    const summary = contentText(result.content);
    expect(summary).toContain('group Launch: 3 entries. cursor t3.');
    expect(summary).toContain('pass full:true');
    expect(summary).not.toContain('hello from the test');
    expect(summary).not.toContain('reply');

    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, limit: 3, target: 'Launch' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    expect(contentText(full.content)).toContain('[user] hello from the test');
    expect(contentText(full.content)).toContain('[send-message] reply');
  });

  it('gbot_thread defaults the limit to 40 like the CLI and reads the other transcript shapes', async () => {
    const empty = await invokeMcpTool('gbot_thread', { input: { target: 'General' }, server: 'grok-bot' });
    expect(calls[1]?.body).toEqual({ id: 'bot-1', limit: 40 });
    expect(empty.structuredContent).toEqual({ cursor: '', entries: [], target: { id: 'bot-1', kind: 'bot', name: 'General' } });
    expect(contentText(empty.content)).toContain('bot General: 0 entries. cursor (none).');

    const legacy = await invokeMcpTool('gbot_thread', { input: { target: 'Legacy' }, server: 'grok-bot' });
    expect(legacy.structuredContent).toMatchObject({
      cursor: 'l4',
      entries: [
        { id: 'l1', kind: 'message', text: 'direct text', truncated: false, fullLength: 11 },
        { id: 'l2', kind: 'note', text: 'part one\npart two\npart three', truncated: false, fullLength: 28 },
        { id: 'l3', kind: 'message', text: 'plain message', truncated: false, fullLength: 13 },
        { id: 'l4', kind: 'message', text: `${'x'.repeat(399)}…`, truncated: true, fullLength: 450 },
      ],
    });
    const legacySummary = contentText(legacy.content);
    expect(legacySummary).toContain('bot Legacy: 4 entries. cursor l4.');
    expect(legacySummary).not.toContain('direct text');
    expect(legacySummary).not.toContain('…');
    expect(legacySummary).not.toContain('x'.repeat(450));
  });

  it('gbot_thread recovers a complete long reply with full:true and normalizes malformed entries', async () => {
    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, target: 'Legacy' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    const fullContent = full.structuredContent as { entries: { id: string; text: string; truncated: boolean; fullLength: number }[] };
    expect(fullContent.entries[3]).toEqual({ id: 'l4', kind: 'message', text: 'x'.repeat(450), truncated: false, fullLength: 450 });
    expect(contentText(full.content)).toContain('x'.repeat(450));

    const odd = await invokeMcpTool('gbot_thread', { input: { target: 'Odd' }, server: 'grok-bot' });
    expect(odd.isError).toBe(false);
    expect(odd.structuredContent).toEqual({
      cursor: 'o3',
      entries: [
        { id: 'o1', kind: 'note', text: '5', truncated: false, fullLength: 1 },
        { id: 'o2', kind: 'mystery', text: '', truncated: false, fullLength: 0 },
        { id: 'o3', kind: 'note', text: 'a�b', truncated: false, fullLength: 3 },
      ],
      target: { id: 'bot-4', kind: 'bot', name: 'Odd' },
    });
    expect(contentText(odd.content)).toContain('bot Odd: 3 entries. cursor o3.');
  });

  it('gbot_thread default summary stays small on a 60-entry tail while full:true reads the text', async () => {
    const summary = await invokeMcpTool('gbot_thread', { input: { limit: 60, target: 'Noisy' }, server: 'grok-bot' });
    expect(summary.isError).toBe(false);
    const structured = summary.structuredContent as { cursor: string; entries: unknown[] };
    expect(structured.entries).toHaveLength(60);
    expect(structured.cursor).toBe('n60');
    const summaryText = contentText(summary.content);
    expect(summaryText).toContain('60 entries. cursor n60.');
    expect(summaryText).not.toContain('update 1');

    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, limit: 60, target: 'Noisy' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    const fullText = contentText(full.content);
    expect(fullText).toContain('update 1');
    // No-op poll token cost ≪ full tail.
    expect(summaryText.length).toBeLessThan(300);
    expect(fullText.length).toBeGreaterThan(10000);
  });

  it('gbot_send stays unknown when the gateway confirms no receipt', async () => {
    const result = await invokeMcpTool('gbot_send', {
      input: { message: 'ping', target: 'Noreceipt' },
      server: 'grok-bot',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      delivery: 'unknown',
      result: { ok: true },
      target: { id: 'bot-5', kind: 'bot', name: 'Noreceipt' },
    });
    expect(contentText(result.content)).toContain('no receipt');
    expect(contentText(result.content)).not.toContain(' as ');
  });

  it('gbot_thread caps aggregate output and keeps the remainder visible in metadata', async () => {
    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, target: 'Big' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    const entries = (full.structuredContent as { entries: { id: string; text: string; truncated: boolean; fullLength: number }[] }).entries;
    expect(entries.length).toBe(11);
    expect(entries[9]?.text.length).toBe(19940);
    expect(entries[9]).toMatchObject({ id: 'b9', truncated: true, fullLength: 20000 });
    expect(entries[10]).toEqual({ id: 'b10', kind: 'note', text: '', truncated: true, fullLength: 20000 });
  });

  it('gbot_thread enforces the requested count even when the gateway ignores the limit', async () => {
    const capped = await invokeMcpTool('gbot_thread', {
      input: { limit: 3, target: 'Big' },
      server: 'grok-bot',
    });
    expect(capped.isError).toBe(false);
    const entries = (capped.structuredContent as { entries: unknown[] }).entries;
    expect(entries.length).toBe(3);
  });

  it('gbot_thread bounds id/kind/role metadata that would bypass the text budget', async () => {
    const odd = await invokeMcpTool('gbot_thread', { input: { target: 'Meta' }, server: 'grok-bot' });
    expect(odd.isError).toBe(false);
    expect(odd.structuredContent).toEqual({
      cursor: `${'i'.repeat(200)}…`,
      entries: [
        {
          id: `${'i'.repeat(200)}…`,
          kind: `${'k'.repeat(200)}…`,
          role: `${'R'.repeat(200)}…`,
          text: 'hi',
          truncated: false,
          fullLength: 2,
        },
      ],
      target: { id: 'bot-7', kind: 'bot', name: 'Meta' },
    });
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
