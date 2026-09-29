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
const shared = [
  'chatgpt_desktop_list_hosts',
  'chatgpt_desktop_list_threads',
  'chatgpt_desktop_open_thread',
  'chatgpt_desktop_read_thread',
  'chatgpt_desktop_search_threads',
  'chatgpt_desktop_send',
  'chatgpt_desktop_status',
  'chatgpt_desktop_wait_reply',
  'claude_send',
  'gbot_bridge_start',
  'gbot_bridge_status',
  'gbot_bridge_stop',
];

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

test('every host projection contains the Desktop skill and every Desktop MCP tool', async () => {
  const root = resolve('artifact');
  const manifest = JSON.parse(await readFile(resolve(root, 'agent-bundle.manifest.json'), 'utf8'));
  const skillPath = 'skills/chatgpt-desktop/SKILL.md';
  assert.ok(manifest.files.some((file) => file.path === skillPath));
  const skill = await readFile(resolve(root, skillPath), 'utf8');
  assert.match(skill, /^---\nname: chatgpt-desktop\n/);
  const desktopTools = shared.filter((name) => name.startsWith('chatgpt_desktop_'));
  const manifestTools = manifest.routes.servers.flatMap((server) => server.routes)
    .map((route) => route.id?.split('/').at(-1))
    .filter((name) => name?.startsWith('chatgpt_desktop_'));
  assert.deepEqual(manifestTools.sort(), [...desktopTools].sort());
  for (const projection of manifest.projections.filter((item) => ['claude', 'codex', 'cursor'].includes(item.host))) {
    const plugin = JSON.parse(await readFile(resolve(root, projection.documents.plugin), 'utf8'));
    if (projection.host !== 'claude') assert.equal(plugin.skills, './skills/');
    const mcp = JSON.parse(await readFile(resolve(root, projection.documents.mcp), 'utf8'));
    const arg = mcp.mcpServers['grok-bot'].args[0];
    const hostEntry = arg.startsWith('./')
      ? resolve(root, arg)
      : arg.replace(/^\$\{(?:CLAUDE|CURSOR)_PLUGIN_ROOT\}/, root);
    const client = new Client({ name: projection.host, version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [hostEntry], stderr: 'pipe' }));
      const listed = new Set((await client.listTools()).tools.map((tool) => tool.name));
      for (const name of desktopTools) assert.ok(listed.has(name), `${projection.host} missing ${name}`);
    } finally {
      await client.close();
    }
  }
});
