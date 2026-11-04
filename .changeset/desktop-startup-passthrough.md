---
"grok-bot-cli": patch
---

Pass Desktop startup configuration, sign-out, and CLI help/version requests through to the real Codex CLI instead of the interactive daemon bridge.

Allow fallback when the bridge reaches EOF without consuming input or committing output. Existing shim users must re-run `gbot codex desktop-shim install` after upgrading, then fully quit and relaunch ChatGPT.
