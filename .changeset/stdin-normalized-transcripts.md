---
"grok-bot-cli": minor
---

Add `send <target> --stdin` so a message can be passed on standard input instead
of the process argument list, with strict UTF-8, non-empty, no-NUL, no
surrounding whitespace and 64 KiB validation. Add a `--normalized` transcript
contract for `thread`/`chat` JSON output that returns only the target identity
and messages with `id`, an explicit `user`/`assistant`/`unknown` role, and text.
The normalizer fails closed on malformed or conflicting evidence rather than
guessing, and keeps normalized text separate from display stringification.
