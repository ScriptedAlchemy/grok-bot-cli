---
"grok-bot-cli": patch
---

Fix `gbot thread` so bot replies (`send-message` entries) show their text instead of empty lines, by sharing transcript parsing with the grok-bot plugin.
