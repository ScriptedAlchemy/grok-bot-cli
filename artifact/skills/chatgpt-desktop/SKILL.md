---
name: chatgpt-desktop
description: Use the gbot ChatGPT Desktop MCP tools to discover hosts and threads, page/search/read conversations, and send or wait for replies on the user's Mac. Use for local Desktop CDP automation and remote-control thread routing; do not use for ordinary Grok Bot messaging.
---
# ChatGPT Desktop through gbot

Use the `chatgpt_desktop_*` MCP tools on the user's Mac. The CLI is a secondary
surface. CDP listens on `127.0.0.1` only; these tools do not transport CDP to
another machine.

## Find the right conversation

1. Call `chatgpt_desktop_status`. `reachable: false` or `exitCode: 1` means
   CDP is down: open/send/wait cannot work. `appServerFallback.reachable` is a
   separate list/search/read probe. Do not retry a send because CDP disappeared.
2. Call `chatgpt_desktop_list_hosts` for dynamic host IDs, labels, and
   `modelProvider` values. `local` is this Mac. A remote-control host ID looks
   like `remote-control:env_e_...`; its `hostName` may be `null`. Do not infer a
   host name from a project label. Managed SSH hosts may have no threads.
3. Use `chatgpt_desktop_list_threads` with `host`, `modelProvider`, or `project`
   as needed. Pass `nextCursor` back as `cursor` with the same filters until it
   is `null`. The cursor refers to a sorted merged inventory; pages normally
   fill `limit` and can stop earlier at the MCP document cap. If the inventory
   changed after a cursor expired, restart without one. Project labels and IDs
   come from Desktop project assignments and workspace roots; `projectRootPath`
   is the resolved root when available.
   `chatgpt_desktop_search_threads` also accepts `cursor`; keep its query and
   filters unchanged. Search matches the full title even when the display row
   has a 200-character `title` and `titleTruncated: true`.
4. Read with `chatgpt_desktop_read_thread`. `full: false` gets the recent tail;
   `full: true` pages chronologically from the start. Pass `nextCursor` back
   as `cursor` with the same thread ID and `full` value until `complete: true`.
   The byte budget can stop before `limit`. An oversized turn is returned as
   ordered fragments with one stable `turnKey`; use `continuation.field`,
   `offsetChars`, and `totalChars` to reassemble `text`, `userText`, and
   `assistantText`. `textTruncated: true` signals a fragment, not missing text.
   Check `complete` and `warnings` before treating a page as full history.

Durable local IDs are `local:<conversationId>` (a bare conversation ID also
works). `local:client-new-thread:*` is temporary and works only while that
conversation remains selected. `REMOTE_THREAD_NOT_LOADED` includes the
owning `hostId`: read or send through gbot running on that host's own Desktop
or app-server. The local Mac cannot fetch that remote history through CDP.

## Open, send, and wait

- `chatgpt_desktop_open_thread` navigates to a durable conversation even if it
  is absent from the sidebar. An archived route returns `archived: true`; the
  thread remains readable through `chatgpt_desktop_read_thread`.
- `chatgpt_desktop_send` with `threadId` sends to that conversation. Omit
  `threadId` and `project` to start outside a project. Omit `threadId` and set
  `project` to start inside that project. The tool verifies the empty new-chat
  view and its project selection before typing. Send once. A new-thread receipt may
  include `temporaryThreadId` and resolves `threadId` to the durable
  `local:<conversationId>` before returning. Keep both until the durable ID is
  confirmed; use the durable ID for later work.
- Then call `chatgpt_desktop_wait_reply` with the returned `threadId` (or the
  selected temporary ID). It returns the reply and durable `conversationId`.
  A timeout is an observation, not permission to resend.

`ARCHIVED_THREAD` means send was rejected before submission. Read remains
available. Pass `unarchive: true` with an existing `threadId` on send only if
the user wants the archive state changed; this explicitly calls app-server
`thread/unarchive` and retries once. Never unarchive merely to read or open.

`COMPOSER_HAS_DRAFT` means the user's draft would be disturbed; leave it for
the operator. `PROJECT_UNAVAILABLE` means Desktop disabled a project's new-chat
action, often because its configured workspace root no longer exists; correct
the project root in Desktop before retrying. `NEW_CHAT_NAVIGATION_FAILED` means
the button did not open the requested empty view within three seconds; inspect
Desktop before retrying. `CDP_UNREACHABLE` requires restoring the local Desktop CDP
endpoint. App-server failures, including oversized frames, appear as errors or
read `warnings` with `complete: false`; inspect the partial result and source
status before continuing. A send with unknown delivery must not be repeated
without checking the selected thread and reply state.
