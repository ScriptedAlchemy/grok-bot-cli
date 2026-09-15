---
"grok-bot-cli": patch
---

Add `gbot codex desktop-shim install|uninstall|status`: installs a fail-open `CODEX_CLI_PATH` wrapper plus stdio-to-WebSocket bridge under `~/.codex/bin/` so ChatGPT Desktop shares the managed Codex app-server daemon (stock `app-server proxy` hangs for Desktop stdio). The wrapper preflights the socket and runs the bridge as a fallible child (no daemon start on the hot path), exports the `CODEX_HOME`-derived socket, the bridge handshake and first RPC run under absolute deadlines with accept validation and continuation assembly, the stdin commit point is byte-precise, `status` reads the macOS GUI-domain env, and `send` no longer answers another client's approvals outside its own turn. macOS persists the GUI env via LaunchAgent; uninstall restores stock Desktop/Codex behavior.
