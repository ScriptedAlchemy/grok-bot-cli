---
"grok-bot-cli": minor
---

Codex → Grok Bot messages now carry a sender prefix, `[from Codex thread <id> @ <machine>, cwd <cwd>; reply: codex_send({threadId:"<id>", message:"..."}) via MCP on <machine> (or CLI: gbot codex send <id> "...")]`, on the managed relay path, the plain `gbot_send` path with a known native thread, and `gbot send` inside a Codex terminal (`$CODEX_THREAD_ID`); unknown fields are omitted. Relay return messages use the same prefix. `codex_threads` / `gbot codex list-threads` now sort by recent activity (`updatedAt`) by default (`sort`: `updated` | `created` | `recency`, `order`), and add `query` (case-insensitive name/title, preview or id prefix, scanning every page), `activeWithin` / `since`, `cwd`, `modelProvider`, `sourceKind` and `archived` filters, so old-but-active threads are no longer hidden past the first 100.
