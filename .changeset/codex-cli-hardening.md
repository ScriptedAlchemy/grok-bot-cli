---
"grok-bot-cli": patch
---

Parse global `gbot` flags only before the command so `gbot codex send` keeps `--json` / `--dir` inside the message; refuse native Windows for `gbot codex` with a clear error; strip terminal controls from thread listings; run unit tests through `scripts/run-unit-tests.mjs` so Windows and Node 18 work without shell globs.
