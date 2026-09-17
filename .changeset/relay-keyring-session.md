---
"grok-bot-cli": patch
---

Isolate relay workers by their desktop keyring environment so headless MCP callers cannot replace the authenticated worker used by desktop CLI callers.
