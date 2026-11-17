---
"grok-bot-cli": patch
---

Grok Bot 1.1 support for bot profiles and groups. `bots update` now saves a cloud bot's edited profile fields on the backend (`UpdateGrokBotAgent`, partial update) before telling the box, like the app does; a box-only write reported success but was undone by the next sync. `groups create` now creates the group on the backend (`CreateGrokBotRoom`), waits for the box to mirror it, then applies title and avatar; the gateway's `createGroup` answers 502 "A Sand box session is not permitted on this endpoint". The gateway remains the fallback for sessions without app credentials.
