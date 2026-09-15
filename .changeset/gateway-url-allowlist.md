---
"grok-bot-cli": patch
---

Send the gateway bearer only to `https` hosts on `*.cursor.sh`, `*.cursor.com`, or `*.cursorvm.com`, and the EnsureSandBox / Cursor access token only to `*.cursor.sh` / `*.cursor.com`; refuse cross-origin fetch redirects; redact Authorization (any scheme), Cookie, and named token fields from error output. `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` admits loopback gateways and `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables the host check; both warn once on stderr.
