---
"grok-bot-cli": patch
---

Strip C0/C1 controls (including CR, backspace, and BEL) from `gbot codex list-threads` text output, not only ESC sequences.
