"grok-bot-cli": patch
---

P1 bridge follow-ups: preserve send receipts with rejected/accepted/unknown delivery states (Codex `CodexSendError` keeps thread/turn IDs, gateway `sendPrompt` returns `delivery` + `messageId` only on a confirmed receipt); bound the Codex WebSocket transport (idempotent close with guaranteed destruction, absolute handshake deadline, exact handshake validation, fragmentation/UTF-8/opcode handling, header/frame/message/buffer budgets); make `gbot_thread` bounded without losing replies (truncation metadata, bounded `full` reads, `--full` in CLI, safe string normalization, 1–200 limit consistency, gateway deadline and streaming response-byte cap).
