---
"grok-bot-cli": patch
---

Send the gateway and EnsureSandBox bearer tokens only to `https` hosts on `*.cursor.sh`, `*.cursor.com`, or `*.cursorvm.com` (the box gateway family EnsureSandBox returns); refuse cross-origin fetch redirects; redact credential-shaped values from error output. `GROK_BOT_ALLOW_LOCAL_GATEWAY=1` admits loopback gateways and `GROK_BOT_ALLOW_ANY_GATEWAY=1` disables the host check.
