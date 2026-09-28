---
"grok-bot-cli": patch
---

Tell Grok Bot agents that Codex/Claude tools use local sockets only: on the box, do not call them — run `gbot` on the user's machine via Grok Bot Shell with a machineId after `codex app-server daemon start` / bootstrap. No remote transport.
