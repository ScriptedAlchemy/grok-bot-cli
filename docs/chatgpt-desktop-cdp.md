# ChatGPT Desktop CDP adapter

`gbot` talks to the ChatGPT / Codex desktop app over the Chrome DevTools
Protocol on **127.0.0.1 only**. There is no remote transport. CDP/DOM details
stay inside `src/core/chatgpt-desktop/`; MCP tools and CLI commands call the
`ChatGptDesktopAdapter` surface.

List / search / read prefer the local Codex **app-server** (verified on
0.158.0). Send / new-thread-in-project / wait-for-reply / selected-thread stay
on CDP. DOM read is a fallback only when app-server is unavailable.

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
gbot chatgpt-desktop hosts
gbot chatgpt-desktop threads --limit 20
gbot chatgpt-desktop threads --host local
gbot chatgpt-desktop threads --host macbook --model-provider openai
gbot chatgpt-desktop search "launch" --host all
gbot chatgpt-desktop read <threadId>
gbot chatgpt-desktop send --thread-id <threadId> "hello"
gbot chatgpt-desktop send "start a new chat with this text"
```

## MCP tools

| Tool | Role |
| --- | --- |
| `chatgpt_desktop_status` | CDP `/json/version` (+ optional attach) and app-server probe |
| `chatgpt_desktop_list_hosts` | Discover hosts + modelProviders (no hardcoding) |
| `chatgpt_desktop_list_threads` | App-server `thread/list`; merge CDP UI + remotes |
| `chatgpt_desktop_search_threads` | App-server list + metadata filter |
| `chatgpt_desktop_read_thread` | App-server `thread/read` + `thread/turns/list` (`itemsView: "full"`) |
| `chatgpt_desktop_send` | Composer submit over CDP (new-thread-in-project included) |
| `chatgpt_desktop_wait_reply` | Poll for a new assistant turn over CDP |

Every list/read/send/wait/open result includes `backend: "cdp" | "app-server"`.

## Thread id mapping

Desktop sidebar rows expose `data-app-action-sidebar-thread-id` as
`local:<conversationId>`. App-server rejects the prefixed form with
`invalid thread id`. Always strip `local:` before RPC calls
(`toAppServerThreadId` / `requireAppServerThreadId`).

| Form | Example | Where |
| --- | --- | --- |
| Desktop sidebar | `local:11111111-1111-1111-1111-111111111111` | CDP DOM |
| App-server | `11111111-1111-1111-1111-111111111111` | JSON-RPC |
| Temporary (CDP-only) | `local:client-new-thread:…` | Composer before first reply |

Turn ids from app-server match DOM keys `history-content:turn:<id>`
(`toDomTurnKey`). App-server history is usually richer than the virtualized
DOM (tool calls, reasoning, timing, and sometimes more turns).

## App-server read protocol (0.158.0)

1. `initialize` then `initialized` notification (via `openCodexSession`)
2. `thread/read` for **metadata only** (`includeTurns` is deprecated for
   paginated threads)
3. Page history with `thread/turns/list` (`itemsView: "full"`, `cursor` /
   `nextCursor`); `thread/items/list` is a fallback
4. **Do not** `thread/resume` for reads — resume attaches a live session

`thread/list` filters to the current model provider by default. Pass
`modelProviders: []` for every provider, and `useStateDbOnly: true` for speed
(~0.02s; a cold rollout scan can take ~36s). Pagination uses `limit` / `cursor`
/ `nextCursor`. The same fix applies to `gbot codex list-threads` /
`codex_threads`.

Surfaced list fields: `id`, `name`, `preview`, `cwd`, `createdAt` /
`updatedAt` (unix s), `section {id,name}` (Pinned → `pinned: true`),
`projectId`, `status`, `modelProvider`, `model`, `originator`. `archived` is a
list filter, not a field.

### Host and modelProvider filters (separate)

`chatgpt_desktop_list_threads` / search take two independent filters:

| Filter | Values | Default | Effect |
| --- | --- | --- | --- |
| `host` | `all` \| `local` \| `<hostId or friendly name>` | `all` | Machine/location from remote summaries + local |
| `modelProvider` | provider id string | omit / `[]` = all | Passed through to app-server `modelProviders` |

Optional `groupBy: "host"` returns `groups[]` keyed by host.

### Host discovery (`chatgpt_desktop_list_hosts`)

Hosts are discovered dynamically — do not hardcode them:

1. Always include `local`
2. Every `remote-thread-summaries-v3:<hostId>` key in
   `~/.codex/.codex-global-state.json`, with friendly names and thread counts
3. If app-server exposes a remote-environment list method, merge those hosts
   too (`hostsSource` names what was used)

`modelProviders` on the same result: prefer a dedicated app-server list method
when present; otherwise distinct `modelProvider` values from `thread/list`
(`modelProviders: []`). `modelProvidersSource` names the path used.

### Remote-control threads

`chatgpt_desktop_list_threads` merges local app-server threads with
remote-control summaries (`location: "local" | "remote"` plus `hostId` /
`hostName`). Remote rows appear in list/search. `chatgpt_desktop_read_thread`
on a remote-only thread raises `RemoteThreadNotLoadedError`
(`REMOTE_THREAD_NOT_LOADED`) with `hostId`, optional `hostName`, and a `hint`
to read it via that host's app-server. SSH remoting is **not** implemented in
this PR (follow-up). The global-state parser is defensive — unknown shapes are
skipped.

## Backend capability matrix

| Operation | CDP | App-server |
| --- | --- | --- |
| `status` | `/json/version` + attach | daemon probe |
| `list_hosts` | — | global-state keys (+ optional remote-env method) + provider discovery |
| `list_threads` | merge selected / UI overlay | primary inventory + remote summaries |
| `search_threads` | merge selected when connected | primary (list + filter, includes remotes) |
| `read_thread` | DOM harvest / wheel **fallback only** (local) | primary; remote → typed error + host hint |
| `open_thread` (selected) | click sidebar row | **not used** (resume attaches) |
| `send` / new-thread-in-project | composer + Enter / project button | **not used** |
| `wait_reply` | Stop gone + final-assistant | **not used** |

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
- Conversation id: `[data-response-annotation-conversation]` — after a new-thread send, `threadId` is this durable id (never `local:client-new-thread:…`; that may appear only as `temporaryThreadId`)
- Open / selected: click sidebar row (bare or `local:` id), wait until “Loading task…” clears (default 90s, timed out)
- Read fallback: harvest rendered turns; full history uses mouseWheel (`deltaY` negative) because the timeline is column-reverse (`scrollTop` 0 is newest and does not load older turns)
- Target attach: exact `app://-/index.html` via `Target.getTargets` (not `/json/list` order)
- CDP: 127.0.0.1 only

## App-server reuse

List / search / read reuse the existing client in `codex-bridge.js`
(`listCodexThreads`, `openCodexSession`, `codexStatus`) — no duplicated
JSON-RPC stack. Send / new-thread-in-project / wait-for-reply stay on CDP.
