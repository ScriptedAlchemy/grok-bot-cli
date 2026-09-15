---
"grok-bot-cli": patch
---

Ship the `grok-bot` agent plugin inside the npm package: `npm install --global grok-bot-cli` now also provides `gbot-install install|uninstall cursor|claude|codex` and `gbot-install doctor` (Node 22.19+), which install the bundled `gbot_send` / `gbot_thread` MCP server and `talk-to-grok-bot` Skill from `plugin/dist` without cloning the repository. `npm run build:plugin` (run automatically by `npm pack` / `npm publish`) produces that directory with `agent-bundle prepack`.
