---
"grok-bot-cli": patch
---

Stack the must-fix set from the Codex reject of the Act-On-PR bridge and the unfinished follow-up accept bar: commit stdout BEFORE writing (dirty stdout never exits 1 / never fail-opens to stock Codex) with bounded stdout writes and termination, keep healthy idle reads untimed (separate absolute handshake/first-RPC deadline from mid-session write/lock budgets), clear the init timer only on the matching initialize response/error (notifications never satisfy it), stay silent on foreign serverRequest approvals (deferring turn-scoped ones until the turn id is known), require strict HTTP/1.1 101 plus accept, flush EOF-tail data before the WS Close, and keep the wrapper hardening (self-fallback refusal, bridge+python3+preflight gating, uninstall reporting, Linux status wording with shell-quoted path).
