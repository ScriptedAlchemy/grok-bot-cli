---
"grok-bot-cli": patch
---

Slice 0 of epic #24: `gbot_thread` returns a short summary plus an opaque client-held `cursor` (last entry id) by default and withholds per-entry text; pass `full:true` to read entry text as before. Halves default poll token cost without touching `gbot history`, auth, or approval handling.
