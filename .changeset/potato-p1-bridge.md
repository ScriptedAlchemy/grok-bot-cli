---
"grok-bot-cli": patch
---

P1 bridge follow-ups: preserve send receipts with rejected/accepted/unknown delivery states (Codex `CodexSendError` keeps thread/turn IDs, gateway `sendPrompt` returns `delivery` + `messageId` and marks post-write loss unknown); bound the Codex WebSocket transport (idempotent close settling pending requests, socket destroy on every failure, exact handshake validation, fragmentation/UTF-8/opcode handling, header/frame/message/buffer budgets); make `gbot_thread` bounded without losing replies (truncation metadata, `full` bounded full-read in tool and `--full` in CLI, safe string normalization, 1–200 limit consistency, gateway deadline and response-byte cap).
