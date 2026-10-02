---
name: codex-dot
description: Find, read, or message the user's OpenAI Dot assistant (Dotty / Your dot) through Codex desktop's native MCP tools.
---

# Codex Dot

Use the native `codex_app` tools. Dotty was observed on host `durable`;
`gbot codex`'s local app-server socket cannot access that host. This skill
routes existing MCP tools; it does not add a CLI command or standalone server.

1. Discover `list_threads`, `read_thread`, and `send_message_to_thread`.
   List recent threads, checking both `threads` and `pinnedThreads` for the
   exact requested name (default `dotty`, case-insensitive). Use returned
   `hostId` fields, not the host embedded in sidebar `itemKeys`.
2. Dotty can have multiple historical threads. Read the newest matching
   conversation on the previously verified host to confirm context. If
   matches belong to different assistants/hosts or the intended conversation
   is unclear, ask which one. Increase the listing limit if necessary; an
   absent result in a bounded list is not proof the assistant is unavailable.
   Never substitute Heartbeat Dreamer or create a new thread as a fallback.
3. Pass the discovered `threadId` and `hostId` to `read_thread`. Use a small
   turnLimit and read older pages only as needed. Do not persist the thread ID:
   the Dot assistant may move to a new conversation.
4. For a user-authorized message, call `send_message_to_thread` once with
   `{threadId, hostId, prompt}`. Preserve the user's intended message; omit
   model/thinking overrides. A discovery, setup, or read request alone does
   not authorize a test message. Ask for content when none is supplied.
5. Report the tool's actual delivery result. Acceptance is not a reply. On
   timeout or ambiguous delivery, inspect the thread before considering a
   retry. For a requested reply, use `wait_threads` with the same host/thread
   and its returned cursor; then read the relevant turn if needed.

If native desktop tools are unavailable, report that limitation. Do not
claim a local CLI send reaches Dotty, extract credentials, patch the app,
or silently redirect the message to another assistant.
