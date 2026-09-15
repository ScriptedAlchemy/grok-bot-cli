import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  // Package-bound installer shipped inside the `grok-bot-cli` tarball as the
  // `gbot-install` bin (`plugin/dist/bin/gbot-install.js`); see README "Install".
  bin: { 'gbot-install': './src/gbot-install.ts' },
  lib: false,
  marketplace: true,
  output: { distPath: 'artifact' },
  plugin: {
    description:
      'Message Grok Bot bots and groups and read their threads from Codex, Claude Code, and Cursor.',
    name: 'grok-bot',
  },
  targets: ['claude', 'codex', 'cursor', 'portable'],
  // `grok-bot-cli` is the parent checkout linked in through `file:..`. Rspack
  // would otherwise realpath the link to a source outside the plugin root,
  // which the compiler rejects; kept as a node_modules path it bundles like
  // any dependency.
  tools: { rspack: { resolve: { symlinks: false } } },
});
