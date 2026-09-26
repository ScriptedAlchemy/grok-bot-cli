import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const sdk = createRequire(import.meta.resolve('agent-bundle/api'));
const { Client } = await import(sdk.resolve('@modelcontextprotocol/client'));
const { StdioClientTransport } = await import(sdk.resolve('@modelcontextprotocol/client/stdio'));
const config = JSON.parse(await readFile(new URL('../artifact/.mcp.json', import.meta.url), 'utf8'));
const entry = config.mcpServers['grok-bot'].args[0].replace('${CLAUDE_PLUGIN_ROOT}', resolve('artifact'));
const codex = ['codex_send', 'codex_threads', 'codex_wait', 'codex_watch', 'gbot_codex_respond'];
const grok = ['gbot_send', 'gbot_thread', 'gbot_grok_approvals', 'gbot_grok_respond'];
const shared = ['claude_send', 'gbot_bridge_start', 'gbot_bridge_status', 'gbot_bridge_stop'];

test('built MCP artifact exposes the other host tools and shared bridge controls', async () => {
  for (const [name, hidden] of [['codex_cli_rs', codex], ['Grok Bot', grok], ['Cursor', []]]) {
    const client = new Client({ name, version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' }));
      const listed = (await client.listTools()).tools.map(tool => tool.name).sort();
      assert.deepEqual(listed, [...codex, ...grok, ...shared].filter(tool => !hidden.includes(tool)).sort());
      for (const tool of hidden) {
        await assert.rejects(client.callTool({ name: tool, arguments: {} }), /disabled|not found/i);
      }
    } finally {
      await client.close();
    }
  }
});
