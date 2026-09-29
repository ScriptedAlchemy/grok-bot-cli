# ChatGPT Desktop CDP adapter

`gbot` talks to the ChatGPT / Codex desktop app over the Chrome DevTools
Protocol on **127.0.0.1 only**. There is no remote transport. CDP/DOM details
stay inside `src/core/chatgpt-desktop/`; MCP tools and CLI commands call the
`ChatGptDesktopAdapter` surface.

## Enable remote debugging (macOS)

Electron fuses on ChatGPT.app block Node inspect / `RunAsNode`, but they do
**not** block Chromium's `--remote-debugging-port`. The port binds to loopback.
Do not depend on `@electron/fuses read` — the framework is renamed
(`Codex Framework.framework`) and that tool fails.

```sh
# Helper-printed command (also available from the module):
# chatgptDesktopRelaunchCommand({ port: 9222 })
osascript -e 'tell application "ChatGPT" to quit' \
  && open -a /Applications/ChatGPT.app --args --remote-debugging-port=9222
```

Bundle id: `com.openai.codex` (ChatGPT.app v26.924.22138 / Chrome 154 explored).

Override the port with `CHATGPT_DESKTOP_CDP_PORT` or `--port`.

## CLI

```sh
gbot chatgpt-desktop status
gbot chatgpt-desktop threads --limit 20
gbot chatgpt-desktop read <threadId>
gbot chatgpt-desktop send --thread-id <threadId> "hello"
gbot chatgpt-desktop send "start a new chat with this text"
```

## MCP tools

| Tool | Role |
| --- | --- |
| `chatgpt_desktop_status` | CDP `/json/version` (+ optional attach) and app-server probe |
| `chatgpt_desktop_list_threads` | Sidebar threads via CDP; app-server `thread/list` fallback |
| `chatgpt_desktop_read_thread` | Virtualized timeline harvest; app-server read/items fallback |
| `chatgpt_desktop_send` | Experimental composer submit; app-server send fallback |
| `chatgpt_desktop_wait_reply` | Experimental poll for a new assistant turn |

Every mutating/list/read result includes `backend: "cdp" | "app-server"`.

## Target selection

Prefer CDP `Target.getTargets`. The main window is `type: "page"` with URL
exactly `app://-/index.html`. Ignore avatar-overlay, detached-window, and
chatgpt.com / sandbox webviews. `/json/list` is incomplete and order-unstable;
use it only as a cheap status hint.

## DOM module

All selectors live in `src/core/chatgpt-desktop/cdp-dom.ts` (sidebar
`data-app-action-sidebar-thread-*`, timeline scroll, `data-turn-key`, user
bubbles, experimental composer candidates). Do not add selectors elsewhere.

## Fallback

When CDP is unreachable, list/read/send/wait/open fall back to the existing
Codex app-server client in `codex-bridge.js` (no duplicated JSON-RPC stack).
Starting a brand-new Desktop thread without a `threadId` still needs CDP.
