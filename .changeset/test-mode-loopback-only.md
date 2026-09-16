---
"grok-bot-cli": patch
---

Refuse every non-loopback gateway or backend URL when `GROK_BOT_TEST=1` or `NODE_ENV=test`, ignoring `GROK_BOT_ALLOW_ANY_GATEWAY`, so the test suites can never send a prompt to a live thread. The unit and route-unit runners set `GROK_BOT_TEST=1`.
