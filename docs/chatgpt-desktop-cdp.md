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
gbot chatgpt-desktop hosts   # discover hostIds + modelProviders at runtime
gbot chatgpt-desktop threads --limit 20
gbot chatgpt-desktop threads --limit 20 --cursor <nextCursor>
gbot chatgpt-desktop threads --host local
gbot chatgpt-desktop threads --host <hostId> --model-provider <providerId>
gbot chatgpt-desktop search "launch" --host all
gbot chatgpt-desktop read <threadId>
gbot chatgpt-desktop send --thread-id <threadId> "hello"
gbot chatgpt-desktop send "start a new chat with this text"
```

`--host` / `--model-provider` accept **any string** (not enums). Discover
allowed values with `gbot chatgpt-desktop hosts` / `chatgpt_desktop_list_hosts`.

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
   `nextCursor`); `thread/items/list` is a fallback only for unsupported RPCs.
   Recent reads request descending pages and return chronological turns;
   `full` reads request ascending pages, bounded by `limit`. Empty history is valid.
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

| Filter | Values (any string — not an enum) | Default | Effect |
| --- | --- | --- | --- |
| `host` | `all` \| `local` \| any hostId / friendly name from `list_hosts` | `all` | Machine/location from remote summaries + local |
| `modelProvider` | any provider id from `list_hosts` | omit / `[]` = all | Passed through to app-server `modelProviders` |

New machines or connections appear in `list_hosts` with **no code change**.

Optional `groupBy: "host"` returns `groups[]` keyed by host.

### Host discovery (`chatgpt_desktop_list_hosts`)

Hosts are discovered dynamically — do not hardcode them:

1. Always include `local`
2. Every `remote-thread-summaries-v3:<hostId>` key in
   `~/.codex/.codex-global-state.json`, including keys under
   `electron-persisted-atom-state`, with thread counts
3. Managed SSH connections in `codex-managed-remote-connections`

`hostName` is the Desktop display name when present, otherwise `null`.
Project labels are not used as machine names. CDP sidebar rows expose their
host id, and matching remote summaries supply ownership when available.

`modelProviders` combines distinct `modelProvider` values from `thread/list`
(`modelProviders: []`) and remote summaries. `modelProvidersSource` names the
local discovery path; if unavailable, remote summaries still contribute.
Failures and page-cap truncation appear in `warnings`.
Explicit provider filters exclude rows whose provider is unknown.

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
| `list_hosts` | — | global-state keys + thread inventory provider discovery |
| `list_threads` | merge selected / UI overlay | primary inventory + remote summaries |
| `search_threads` | merge selected when connected | primary (list + filter, includes remotes) |
| `read_thread` | DOM harvest / wheel **fallback only** (local) | primary; remote → typed error + host hint |
| `open_thread` (selected) | click sidebar row or navigate through Desktop's memory router by conversation id | **not used** (resume attaches) |
| `send` / new-thread-in-project | composer + Enter / project button | **not used** |
| `wait_reply` | Stop gone + final-assistant | **not used** |

`status.reachable` and its process exit code report CDP availability; the
app-server probe is separate. List/search results report `app-server+cdp`
when both contribute, and append `remote-state` when remote summaries
contribute. `read_thread` returns `complete` and `warnings` so a CDP fallback
cannot be mistaken for a complete app-server read. A turn may contain both
`userText` and `assistantText`; `endedAt` uses the app-server `completedAt`.
Full reads page from the oldest turn until completion, with a default cap of
2000 turns; an explicit `limit` can lower that cap.
Archived conversations can be read through app-server, but Desktop requires
an explicit unarchive before opening them for interaction.

## Target selection

Prefer CDP `Target.getTargets`. The main window is `type: "page"` with URL
exactly `app://-/index.html`. Ignore avatar-overlay, detached-window, and
chatgpt.com / sandbox webviews. `/json/list` is incomplete and order-unstable;
use it only as a cheap status hint.

## DOM module

All selectors live in `src/core/chatgpt-desktop/cdp-dom.ts`:

- Composer: `[data-codex-composer=true][contenteditable=true]` — `focus()` then `Input.insertText`
- Submit: Enter via `Input.dispatchKeyEvent` (rawKeyDown/keyUp), waits for the composer to clear without resubmitting
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

## Operation boundaries

CDP HTTP discovery rejects redirects and non-loopback debugger URLs. Discovery
and connection attempts time out after 5 seconds; individual CDP requests after
10 seconds. CLI/MCP calls close their connection on completion and serialize
access to the shared Desktop composer within one process.

Opening a thread waits for its conversation annotation as well as the absence
of “Loading task…”, so a still-rendered previous chat is not used. Reply waits
require the latest turn to have a final reply with Stop absent. A timeout is
reported as a timeout, never as a successful partial reply. Changing the
selected conversation during a wait fails the operation. A requested project
must exist; it does not silently fall back to an unrelated new chat.

Separate CLI processes and manual Desktop interaction can still race with UI
operations; avoid driving the same window concurrently. DOM selectors and the
remote-summary file format are app-internal and can change between releases.

Sends refuse an existing composer draft or active reply. Once Enter is dispatched,
a missing acknowledgment or durable conversation ID reports unknown delivery;
it must not be retried blindly. A send/wait pair in the same MCP process tracks
the pre-submit turn key to avoid returning the previous answer.
