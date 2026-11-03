---
"grok-bot-cli": patch
---

Confirm `{ accepted: true }` send acknowledgements by finding the request's clientNonce in the transcript tail, so delivered messages report `delivery: "accepted"` with a messageId instead of `unknown`.
