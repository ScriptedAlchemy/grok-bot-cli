---
"grok-bot-cli": patch
---

`gbot codex new --cwd DIR "message"` and `codex_new` with a first message work on Codex 0.160 daemons: a thread created by `thread/start` has no rollout until its first turn exists, so the follow-up `thread/resume` answered "no rollout found" and the first message was rejected as `unknown-thread`. The first send now treats the just-created thread as idle and starts its turn directly.
