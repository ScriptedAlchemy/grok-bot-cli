import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  bin: {
    'gbot-install': './src/gbot-install.ts',
  },
  lib: false,
  marketplace: true,
  output: { distPath: 'artifact', repositoryMarketplace: true },
  plugin: {
    description:
      'Message Grok Bot from Codex, Claude Code, and Cursor, with managed automatic replies and explicit Codex conversation links.',
    // plugin.name is also the routed bin name: `dist/bin/gbot.mjs`.
    name: 'gbot',
  },
  runtime: { node: '22.19.0' },
  targets: ['claude', 'codex', 'cursor', 'portable'],
});
