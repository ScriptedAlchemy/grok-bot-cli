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
| `chatgpt_desktop_list_threads` | App-server `thread/list` when available; merges CDP sidebar fields |
| `chatgpt_desktop_read_thread` | Visible turns via CDP; deep/full history via app-server |
| `chatgpt_desktop_send` | Composer submit over CDP (new-thread-in-project included) |
| `chatgpt_desktop_wait_reply` | Poll for a new assistant turn over CDP |

Every list/read/send/wait/open result includes `backend: "cdp" | "app-server"`.

## Thread id mapping

Desktop sidebar rows expose `data-app-action-sidebar-thread-id` as
`local:<conversationId>`. The Codex app-server uses the bare `<conversationId>`
for `thread/list`, `thread/read`, and `thread/resume`.

| Form | Example | Where |
| --- | --- | --- |
| Desktop sidebar | `local:11111111-1111-1111-1111-111111111111` | CDP DOM |
| App-server | `11111111-1111-1111-1111-111111111111` | `codex-bridge` / app-server |
| Temporary (CDP-only) | `local:client-new-thread:…` | Composer before first reply |

Helpers in `thread-ids.ts` (`toAppServerThreadId`, `toDesktopThreadId`,
`appServerThreadIdCandidates`) accept either durable form. Temporary
`local:client-new-thread:…` ids do **not** map until
`data-response-annotation-conversation` resolves a real conversation id.
List/read results prefer the Desktop `local:…` form so callers can round-trip
the same id into send/wait.

## Backend capability matrix

| Operation | CDP | App-server |
| --- | --- | --- |
| `status` | `/json/version` + attach | daemon probe (`codexStatus`) |
| `list_threads` | sidebar DOM (pinned/selected/project/kind) | primary inventory (`thread/list`) |
| `read_thread` (visible / limit ≤ on-screen) | harvest rendered turns | — |
| `read_thread` (full / limit > visible) | wheel crawl **fallback only** | primary (`thread/read`, resume+turns, turns/items list) |
| `open_thread` | click sidebar row | `thread/resume` fallback when CDP down |
| `send` / new-thread-in-project | composer + Enter / project button | **not used** |
| `wait_reply` | Stop gone + final-assistant | **not used** |

List merges app-server rows with CDP-only fields (`pinned`, `selected`,
`project`, `kind`) when CDP is connected, and appends CDP-only temporary rows.

## Target selection

Prefer CDP `Target.getTargets`. The main window is `type: "page"` with URL
exactly `app://-/index.html`. Ignore avatar-overlay, detached-window, and
chatgpt.com / sandbox webviews. `/json/list` is incomplete and order-unstable;
use it only as a cheap status hint.

## DOM module

All selectors live in `src/core/chatgpt-desktop/cdp-dom.ts`:

- Composer: `[data-codex-composer=true][contenteditable=true]` — `focus()` then `Input.insertText`
- Submit: Enter via `Input.dispatchKeyEvent` (rawKeyDown/char/keyUp), Send button fallback
- Reply done: `main button[aria-label="Stop"]` gone + new `[data-local-conversation-final-assistant=true]`
- Reply text: last turn’s `[data-local-conversation-final-assistant=true] [data-markdown-text-style=assistant-message]`
- New chat: `button[aria-label="Start new chat in <project>"]` (preferred) or sidebar “New chat”
- Conversation id: `[data-response-annotation-conversation]` (resolves `local:client-new-thread:…`)
- Open: click sidebar row, wait until “Loading task…” clears (default 90s)
- Visible read: harvest currently rendered turns (no wheel)
- Full-read fallback: mouseWheel (negative deltaY) on `[data-app-action-timeline-scroll]` (column-reverse); skip `history-gap:` keys — only when app-server misses the thread or is unreachable

## App-server reuse

Deep history and thread listing reuse the existing client in `codex-bridge.js`
(`listCodexThreads`, `openCodexSession`, `codexStatus`) — no duplicated
JSON-RPC stack. Send / new-thread-in-project / wait-for-reply stay on CDP
because those Desktop UI actions are not app-server operations in this adapter.
