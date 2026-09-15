---
"grok-bot-cli": patch
---

HOLD-fix follow-up for the P1 bridge work: gateway reads count true bytes through a streaming reader that cancels on overflow; Codex transport uses an absolute handshake deadline, caps terminated headers and complete frames before decoding, guarantees socket destruction on close, and routes malformed RPC through failure handling; CLI `--json` failures emit structured errors with delivery and IDs; sends stay `unknown` without a confirmed receipt; MCP full reads add aggregate budgets with truncation metadata and a CLI continuation path.
