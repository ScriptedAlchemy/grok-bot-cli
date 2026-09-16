---
"grok-bot-cli": patch
---

Report Desktop shim configuration separately from attachment evidence. `gbot codex status` now includes `desktopShimConfigured` and no longer emits `attached-shim` merely because the wrapper is installed and selected. Preserve observed private-stdio processes and report managed attachment as unverified, including when the daemon is unreachable.
