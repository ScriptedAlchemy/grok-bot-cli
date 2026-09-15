---
"grok-bot-cli": patch
---

Add `gbot codex desktop-shim install|uninstall|status`: installs a fail-open `CODEX_CLI_PATH` wrapper plus stdio-to-WebSocket bridge under `~/.codex/bin/` so ChatGPT Desktop shares the managed Codex app-server daemon (stock `app-server proxy` hangs for Desktop stdio). The wrapper preflights the socket and runs the bridge as a fallible child, exports the `CODEX_HOME`-derived socket, the bridge handshake is timeout-bounded, and `status` reads the macOS GUI-domain env. macOS persists the GUI env via LaunchAgent; uninstall restores stock Desktop/Codex behavior.
