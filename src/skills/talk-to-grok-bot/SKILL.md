---
name: talk-to-grok-bot
description: Send or read Grok Bot threads via gbot_send/gbot_thread and Codex daemon threads via codex_send/codex_threads. Use when handing off to a named bot/group or posting a status note agents watch — not for work you can finish yourself.
---
# Talk to Grok Bot

MCP tools on the `grok-bot` server use the same gateway as the `gbot` CLI.

## When to load this

- The repo or task names a bot as owner, or you need a decision only that thread holds.
- You want a short status note in a shared group other agents watch.

Do not ping a bot for work you can finish yourself. Replies are asynchronous — never block a turn waiting.

## How

1. `gbot_send` with `target` (name or id) and `message` (first line: who you are + what you need).
2. Later, call `gbot_thread` with the same `target` (`limit` defaults to 40). The default receipt has only `summary`, `cursor`, `entryCount`, and `gapReset`; it never includes entries.
3. Poll with the previous `cursor` as `after`. This is exclusive and client-side: `entryCount: 0` means no change.
4. Pass `full: true` only when entry bodies are needed inline; it adds bounded `entries` to structured content, not to `Agent.Text`. If `gapReset` is true, repeat the same call with `full: true` to inspect the bounded reset snapshot.

Bot replies are `send-message` entries; yours are `message` with `role: user`.

List targets with `gbot bots list` / `gbot groups list` when the name is ambiguous.

## CLI automation

The bundled `gbot` and `gbot-install` executables require Node.js 22.19.0 or newer.
For `gbot send`, `gbot codex status`, and `gbot codex send` with `--json`, read the result
document from stdout and branch on its `exitCode`, `mode`, `reason`, and `delivery`.
Framework argument/schema errors use stderr and exit 2. `--json` is reserved before
`--`; put `--` before flag-like message text.

## Auth

Same order as `gbot`: explicit `GROK_BOT_GATEWAY_*`, else Grok Bot app session, else `CURSOR_ACCESS_TOKEN`. `gbot doctor` shows which source is present.

## Codex conversation tools

The generated Codex, Cursor, and Claude plugins and portable MCP artifact expose these
additional tools on the same `grok-bot` MCP server. Codex tools use the local Codex
app-server control socket; Grok tools use the Grok gateway. Portable MCP artifacts
must be configured in an MCP-capable host; they are not automatically loaded by the Grok app.

- `codex_threads`: bounded discovery of daemon-managed Codex threads.
- `codex_send`: submit a message with a correlation envelope. Default delivery is
  immediate acceptance, which does not mean execution finished. `wait: true` adds
  bounded execution and final reply fields. An accepted message remains accepted
  when observation times out or execution fails.
- `codex_wait`: explicitly observe a known thread/turn and recover its final output.
- `codex_watch`: diagnostic observation of bounded thread events. It never answers approvals.

Use `expectedCwd` to verify the destination workspace. Busy sends reject by default;
`whenBusy: queue` needs `GROK_BOT_CODEX_EXPERIMENTAL=1`. Explicit `whenBusy: steer`
requires `expectedTurnId` and visibly rejects a stale guard without retrying another turn.
Final replies omit commentary/reasoning; older phase-null agent messages are a fallback
only after terminal execution. Inspect `reply.truncated` and execution errors for coverage limits.

CLI equivalents are `gbot codex send --wait --timeout-ms 1000 THREAD_ID hello --json`,
`gbot codex wait --timeout-ms 1000 THREAD_ID TURN_ID --json`, and
`gbot codex watch --timeout-ms 1000 --max-events 20 THREAD_ID --json`.
Use framework `--ndjson` for progress. Wait/watch are explicit diagnostics; automatic
background reply routing is not provided by this conversation slice.
