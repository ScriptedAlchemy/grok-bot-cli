---
"grok-bot-cli": patch
---

Add `description` frontmatter to the `codex-send`, `codex-threads`, and `codex-wait` plugin commands so `claude plugin validate --strict` and `gbot-install doctor` no longer report AB6020 "No frontmatter block found".
