---
"grok-bot-cli": patch
---

Tighten Desktop private-stdio detection so probe-shell cmdlines that only mention ChatGPT.app + app-server + codex-app-tools no longer false-positive; keep the Resources/codex path match.
