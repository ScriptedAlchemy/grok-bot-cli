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
    entries: [
      { id: 'i'.repeat(300), kind: 'k'.repeat(300), role: 'R'.repeat(5000), text: 'hi' },
      { id: 'last-valid-id', kind: 7 },
    ],
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
    expect([...surface.tools].sort()).toEqual(['codex_send', 'codex_threads', 'codex_wait', 'codex_watch', 'gbot_send', 'gbot_thread']);
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
      entryCount: 3,
      gapReset: false,
      summary: '3 entries',
    });
    expect(calls[1]).toMatchObject({ body: { id: 'grp-1', limit: 3 }, method: 'getAgentTranscriptTail' });
    const summary = contentText(result.content);
    expect(summary).toBe('3 entries');
    expect(summary).not.toContain('hello from the test');
    expect(summary).not.toContain('reply');

    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, limit: 3, target: 'Launch' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    expect(full.structuredContent).toEqual({
      cursor: 't3',
      entryCount: 3,
      entries: [
        { id: 't1', kind: 'message', role: 'user', text: 'hello from the test', truncated: false, fullLength: 19, timestampMs: 1 },
        { id: 't2', kind: 'send-message', text: 'reply', truncated: false, fullLength: 5 },
        { id: 't3', kind: 'tool-call', text: '', truncated: false, fullLength: 0 },
      ],
      gapReset: false,
      summary: '3 entries',
    });
    expect(contentText(full.content)).toBe('3 entries');
  });

  it('gbot_thread defaults the limit to 40 like the CLI and reads the other transcript shapes', async () => {
    const empty = await invokeMcpTool('gbot_thread', { input: { target: 'General' }, server: 'grok-bot' });
    expect(calls[1]?.body).toEqual({ id: 'bot-1', limit: 40 });
    expect(empty.structuredContent).toEqual({
      cursor: '',
      entryCount: 0,
      gapReset: false,
      summary: '0 entries',
    });
    expect(contentText(empty.content)).toBe('0 entries');

    const legacy = await invokeMcpTool('gbot_thread', { input: { target: 'Legacy' }, server: 'grok-bot' });
    expect(legacy.structuredContent).toEqual({
      cursor: 'l4',
      entryCount: 4,
      gapReset: false,
      summary: '4 entries',
    });
    const legacySummary = contentText(legacy.content);
    expect(legacySummary).toBe('4 entries');
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
    expect(contentText(full.content)).not.toContain('x'.repeat(450));

    const odd = await invokeMcpTool('gbot_thread', { input: { full: true, target: 'Odd' }, server: 'grok-bot' });
    expect(odd.isError).toBe(false);
    expect(odd.structuredContent).toEqual({
      cursor: 'o3',
      entryCount: 3,
      entries: [
        { id: 'o1', kind: 'note', text: '5', truncated: false, fullLength: 1 },
        { id: 'o2', kind: 'mystery', text: '', truncated: false, fullLength: 0 },
        { id: 'o3', kind: 'note', text: 'a�b', truncated: false, fullLength: 3 },
      ],
      gapReset: false,
      summary: '3 entries',
    });
    expect(contentText(odd.content)).toBe('3 entries');
  });

  it('gbot_thread returns tiny no-op receipts and exclusive deltas without sending after upstream', async () => {
    const summary = await invokeMcpTool('gbot_thread', { input: { limit: 60, target: 'Noisy' }, server: 'grok-bot' });
    expect(summary.isError).toBe(false);
    const structured = summary.structuredContent as { cursor: string; entries?: unknown[]; entryCount: number };
    expect(structured.entries).toBeUndefined();
    expect(structured.cursor).toBe('n60');
    expect(structured.entryCount).toBe(60);
    expect(JSON.stringify(structured)).not.toContain('update 1');
    expect(Buffer.byteLength(JSON.stringify(structured))).toBeLessThan(4096);
    const summaryText = contentText(summary.content);
    expect(summaryText).toBe('60 entries');
    expect(summaryText).not.toContain('update 1');

    const newer = await invokeMcpTool('gbot_thread', {
      input: { after: 'n58', full: true, limit: 60, target: 'Noisy' },
      server: 'grok-bot',
    });
    expect(newer.isError).toBe(false);
    expect(newer.structuredContent).toMatchObject({
      cursor: 'n60',
      entryCount: 2,
      gapReset: false,
      summary: '2 new',
    });
    expect((newer.structuredContent as { entries: { id: string }[] }).entries.map((entry) => entry.id)).toEqual(['n59', 'n60']);

    const unchanged = await invokeMcpTool('gbot_thread', {
      input: { after: 'n60', limit: 60, target: 'Noisy' },
      server: 'grok-bot',
    });
    expect(unchanged.isError).toBe(false);
    expect(unchanged.structuredContent).toMatchObject({
      cursor: 'n60',
      entryCount: 0,
      gapReset: false,
      summary: '0 new',
    });
    expect((unchanged.structuredContent as { entries?: unknown[] }).entries).toBeUndefined();

    const full = await invokeMcpTool('gbot_thread', {
      input: { full: true, limit: 60, target: 'Noisy' },
      server: 'grok-bot',
    });
    expect(full.isError).toBe(false);
    const fullText = JSON.stringify(full.structuredContent);
    expect(fullText).toContain('update 1');
    expect(contentText(full.content)).not.toContain('update 1');
    expect(Buffer.byteLength(JSON.stringify(unchanged.structuredContent))).toBeLessThan(Buffer.byteLength(fullText) / 10);
    expect(calls.filter((call) => call.method === 'getAgentTranscriptTail').every((call) => !('after' in call.body))).toBe(true);
  });

  it('gbot_thread resets unknown cursors with one bounded snapshot', async () => {
    const reset = await invokeMcpTool('gbot_thread', {
      input: { after: 'bogus', full: true, limit: 40, target: 'Noisy' },
      server: 'grok-bot',
    });
    expect(reset.isError).toBe(false);
    expect(reset.structuredContent).toMatchObject({
      cursor: 'n60',
      entryCount: 40,
      gapReset: true,
      summary: '40 entries; gap reset',
    });
    const entries = (reset.structuredContent as { entries: { id: string }[] }).entries;
    expect(entries).toHaveLength(40);
    expect(entries[0]?.id).toBe('n21');
    expect(entries[39]?.id).toBe('n60');
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
      input: { full: true, limit: 3, target: 'Big' },
      server: 'grok-bot',
    });
    expect(capped.isError).toBe(false);
    const cappedContent = capped.structuredContent as { cursor: string; entries: { id: string }[] };
    expect(cappedContent.entries.map((entry) => entry.id)).toEqual(['b8', 'b9', 'b10']);
    expect(cappedContent.cursor).toBe('b10');
  });

  it('gbot_thread bounds id/kind/role metadata that would bypass the text budget', async () => {
    const summary = await invokeMcpTool('gbot_thread', { input: { target: 'Meta' }, server: 'grok-bot' });
    expect(summary.isError).toBe(false);
    expect(summary.structuredContent).toEqual({
      cursor: 'last-valid-id',
      entryCount: 2,
      gapReset: false,
      summary: '2 entries',
    });
    const summaryText = contentText(summary.content);
    expect(summaryText).not.toContain('i'.repeat(300));
    expect(summaryText.length).toBeLessThan(300);

    const odd = await invokeMcpTool('gbot_thread', { input: { full: true, target: 'Meta' }, server: 'grok-bot' });
    expect(odd.isError).toBe(false);
    expect(odd.structuredContent).toEqual({
      cursor: 'last-valid-id',
      entryCount: 2,
      entries: [
        {
          id: `${'i'.repeat(200)}…`,
          kind: `${'k'.repeat(200)}…`,
          role: `${'R'.repeat(200)}…`,
          text: 'hi',
          truncated: false,
          fullLength: 2,
        },
        { id: '', kind: 'unknown', text: '', truncated: false, fullLength: 0 },
      ],
      gapReset: false,
      summary: '2 entries',
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

  it('refuses a live gateway host under the test runner and still serves the loopback fake', async () => {
    // rstest.route-unit.config.ts sets GROK_BOT_TEST=1; the URL policy then turns any
    // non-loopback gateway into a tool error before a request is built.
    // Non-routable host plus the production escape hatch: production policy would
    // proceed, test mode must refuse, and a regression cannot reach a real gateway.
    const loopbackUrl = process.env.GROK_BOT_GATEWAY_URL;
    process.env.GROK_BOT_GATEWAY_URL = 'https://gateway.invalid';
    process.env.GROK_BOT_ALLOW_ANY_GATEWAY = '1';
    try {
      const live = await invokeMcpTool('gbot_send', {
        input: { message: 'must not leave the machine', target: 'General' },
        server: 'grok-bot',
      });
      expect(live.isError).toBe(true);
      expect(contentText(live.content)).toBe(
        'Rejected gateway URL host "gateway.invalid": test mode (GROK_BOT_TEST / NODE_ENV=test) only allows http(s) loopback gateways.',
      );
      expect(calls).toEqual([]);
    } finally {
      process.env.GROK_BOT_GATEWAY_URL = loopbackUrl;
      delete process.env.GROK_BOT_ALLOW_ANY_GATEWAY;
    }
    const local = await invokeMcpTool('gbot_send', {
      input: { message: 'loopback is fine', target: 'General' },
      server: 'grok-bot',
    });
    expect(local.structuredContent).toEqual({
      delivery: 'accepted',
      messageId: 'm-1',
      result: { messageId: 'm-1' },
      target: { id: 'bot-1', kind: 'bot', name: 'General' },
    });
    expect(calls[1]).toMatchObject({ body: { agentId: 'bot-1', prompt: 'loopback is fine' }, method: 'sendPrompt' });
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
