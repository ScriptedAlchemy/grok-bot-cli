---
"grok-bot-cli": minor
---

Scaffold ChatGPT Desktop CDP adapter and MCP/CLI tools (`chatgpt_desktop_*`). List/search keep separate `host` / `modelProvider` filters; `list_hosts` discovers hosts and providers. Codex list-threads always passes `modelProviders: []`, pages via `nextCursor`, and falls back from `useStateDbOnly` when empty. Codex send/read/wait strip Desktop `local:` ids; remote-control "thread not loaded" maps to `REMOTE_THREAD_NOT_LOADED` with host. Thread reads use `thread/read` metadata + `thread/turns/list` (never deprecated `includeTurns`).

Keep CDP loopback-only across discovery, bound and close sessions, serialize UI operations, distinguish partial replies and uncertain sends, and preserve dynamic remote/provider filtering and ordered empty-safe history reads.
