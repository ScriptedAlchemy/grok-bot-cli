---
"grok-bot-cli": minor
---

Scaffold ChatGPT Desktop CDP adapter and MCP/CLI tools (`chatgpt_desktop_*`, `gbot chatgpt-desktop`). Visible reads stay on CDP; deep/full history and thread listing prefer the existing Codex app-server client (`local:<id>` ↔ bare thread id), with DOM wheel crawl as last-resort fallback. Send / new-thread / wait stay on CDP. Results report `backend`.
