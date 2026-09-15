---
"grok-bot-cli": minor
---

Ship `gbot` as one generated Agent Bundle CLI at the package root and add `gbot-install install|uninstall <cursor|codex|claude>` / `gbot-install doctor` for the bundled `grok-bot` MCP tools and `talk-to-grok-bot` skill; delete the nested `plugin/` project and the hand-written dispatcher. Breaking (pre-1.0): Node.js 22.19.0 or newer is required; options are command-local (`gbot send --history-dir DIR …`, no leading globals); `--json` is reserved anywhere before `--`, so put `--` before flag-like message text; `send`, `codex send`, and `codex status` write one JSON document to stdout with `exitCode` (failures keep `error`, `delivery`, `reason`, `mode` and exit 1); argument and schema errors exit 2. (#PR)
