---
"grok-bot-cli": patch
---

Harden the Desktop shim bridge per follow-up review: bound every send/lock with the monotonic session budget (no pong/cleanup hang on a non-reading peer), track the first daemon response instead of any notification for the first-RPC deadline, commit on input or output (never fall back to stock on used stdout), answer approvals only for the turn gbot started (foreign thread/Desktop turn stays silent), require HTTP/1.1 101 plus accept, and flush EOF-tail data before the WS Close.
