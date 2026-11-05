---
"grok-bot-cli": patch
---

Send prompts through the Cursor backend (`SendGrokBotUserMessage`) when running from Cursor credentials. The gateway now answers `/api/sendPrompt` with 502 "A Sand box session is not permitted on this endpoint" for box sessions.
