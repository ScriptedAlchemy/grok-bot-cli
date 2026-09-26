import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openClaudeChannel, sendToClaude } from '../src/core/claude-channel.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import createClaudeChannel from '../src/mcp/claude-channel.ts';

test('private Claude channel delivers correlated replies and refuses expired or invalid input', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gbot-claude-'));
  const events = [];
  let channel;
  try {
    channel = await openClaudeChannel({ name: 'test', directory, notify: async event => {
      events.push(event);
      if (event.content === 'ping') queueMicrotask(() => channel.reply(event.meta.request_id, 'pong'));
    } });
    assert.equal((await stat(channel.socketPath)).mode & 0o777, 0o600);
    const result = await sendToClaude({ name: 'test', directory, message: 'ping', timeoutMs: 1000 });
    assert.equal(result.delivery, 'replied');
    assert.equal(result.reply, 'pong');
    assert.equal(events[0].meta.request_id, result.requestId);
    assert.throws(() => channel.reply(result.requestId, 'again'), /pending/);
    const timeout = await sendToClaude({ name: 'test', directory, message: 'silent', timeoutMs: 30 });
    assert.equal(timeout.delivery, 'unknown');
    assert.throws(() => channel.reply(timeout.requestId, 'late'), /pending/);
    await assert.rejects(sendToClaude({ name: '../bad', directory, message: 'x' }), /name/);
    await assert.rejects(sendToClaude({ name: 'test', directory, message: 'x'.repeat(65537) }), /64 KiB/);
    await assert.rejects(openClaudeChannel({ name: 'test', directory, notify: async () => {} }), /EADDRINUSE/);
    assert.equal((await sendToClaude({ name: 'test', directory, message: 'ping' })).reply, 'pong');
    await chmod(directory, 0o755);
    await assert.rejects(sendToClaude({ name: 'test', directory, message: 'ping' }), /0700/);
    await assert.rejects(openClaudeChannel({ name: 'other', directory, notify: async () => {} }), /0700/);
  } finally {
    await channel?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude MCP handshake advertises the native channel and reply tool completes a socket request', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gbot-claude-mcp-'));
  const mcp = createClaudeChannel({ name: 'mcp', directory });
  const [client, server] = InMemoryTransport.createLinkedPair();
  let nextId = 0;
  const requests = new Map();
  let receiveEvent;
  const event = new Promise(resolve => { receiveEvent = resolve; });
  client.onmessage = message => {
    if (message.method === 'notifications/claude/channel') receiveEvent(message.params);
    else if (requests.has(message.id)) { requests.get(message.id)(message); requests.delete(message.id); }
  };
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++nextId;
    requests.set(id, resolve);
    void client.send({ jsonrpc: '2.0', id, method, params });
  });
  try {
    await mcp.connect(server);
    await client.start();
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.269' } });
    assert.deepEqual(init.result.capabilities.experimental['claude/channel'], {});
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = await rpc('tools/list', {});
    assert.equal(tools.result.tools[0].name, 'claude_reply');
    for (let attempt = 0; ; attempt++) {
      try { await stat(join(directory, 'mcp.sock')); break; }
      catch (error) { if (attempt > 100) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    const answer = sendToClaude({ name: 'mcp', directory, message: 'hello', timeoutMs: 2000 });
    const notification = await event;
    assert.equal(notification.content, 'hello');
    const reply = await rpc('tools/call', { name: 'claude_reply', arguments: { requestId: notification.meta.request_id, text: 'Claude reply' } });
    assert.notEqual(reply.result.isError, true);
    assert.equal((await answer).reply, 'Claude reply');
  } finally {
    await mcp.close();
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
