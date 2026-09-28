import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  bin: {
    'gbot-install': './src/gbot-install.ts',
  },
  lib: false,
  mcp: { servers: { 'claude-channel': { targets: ['claude'] } } },
  claude: { channels: [{ server: 'claude-channel' }] },
  marketplace: true,
  output: { distPath: 'artifact', repositoryMarketplace: true },
  plugin: {
    description:
      'Message Grok Bot from Codex, Claude Code, and Cursor. Codex/Claude tools use local sockets on the user\'s registered machines only (no remote transport); from the Grok Bot box, run gbot via Grok Bot Shell with a machineId.',
    // plugin.name is also the routed bin name: `dist/bin/gbot.mjs`.
    name: 'gbot',
  },
  runtime: { node: '22.19.0' },
  targets: ['claude', 'codex', 'cursor', 'portable'],
});
