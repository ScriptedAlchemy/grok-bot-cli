import { defineConfig } from 'agent-bundle/config';

/**
 * One Agent Bundle project at repo root — same shape as cargo-hauler.
 * Nested `plugin/` + hand `src/cli.js` are gone; hosts and npm share this tree.
 *
 * - `src/mcp/grok-bot/tools/*` → MCP tools
 * - `src/cli/**` → npm CLI, including send/thread/history and Codex
 * - `src/gbot-install.ts` → `gbot-install` host installer
 * - `src/core/*` → domain (gateway, store, codex-bridge, …)
 * - `src/skills/*` → installed skills
 */
export default defineConfig({
  bin: {
    'gbot-install': './src/gbot-install.ts',
  },
  lib: false,
  marketplace: true,
  output: { distPath: 'artifact' },
  plugin: {
    description:
      'Message Grok Bot from Codex, Claude Code, and Cursor, with managed automatic replies and explicit Codex conversation links.',
    // plugin.name is also the routed bin name: `dist/bin/gbot.mjs`.
    name: 'gbot',
  },
  runtime: { node: '22.19.0' },
  targets: ['claude', 'codex', 'cursor', 'portable'],
});
