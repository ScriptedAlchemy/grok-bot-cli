---
"grok-bot-cli": minor
---

Add `gbot codex status`, `gbot codex list-threads [--limit N]`, and `gbot codex send <threadId> <message...>`: attach to the local Codex app-server daemon socket (`$CODEX_HOME/app-server-control/app-server-control.sock`) with a built-in WebSocket client, list threads, and start a turn with documented JSON-RPC (`thread/resume` + `turn/start`). Reports an absent socket (no daemon or ChatGPT Desktop private mode), unknown threads, threads owned by another client, and refuses server approval requests instead of approving them. Method names are pinned to Codex 0.154.0.
