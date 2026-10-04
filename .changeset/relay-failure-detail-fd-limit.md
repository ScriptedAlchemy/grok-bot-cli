---
"grok-bot-cli": patch
---

Codex delivery failures are now explained instead of reported as a bare "Delivery rejected": managed-relay receipts carry a `detail` field (the Codex daemon's own error text), `gbot codex send --reply-to-grok` / `codex_send` print the reason, the detail and the next step (busy thread, `systemError`, queue unavailable), a failed Codex turn returns its error to Grok instead of "no final text", and `--when-busy queue` on a managed send says to omit it (guarded steer is the default) or use `steer`/`reject`. The macOS daemon login script (`gbot codex desktop-shim`) now raises the open-file limit before starting the Codex daemon: launchd's 256-file soft limit made a busy daemon fail turns with "Too many open files" and put threads into `systemError`.
