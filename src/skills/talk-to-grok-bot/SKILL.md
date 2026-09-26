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

1. Send once with `gbot_send` (`target`, `message`). Say who you are and what you need.
2. Read its `replyRoute`. Native Codex calls with proven native lineage get `mode: auto`;
   continue work and receive the matching reply in that same thread. Do not poll or
   hold a tool call open. That reply does not automatically send your next answer back.
3. If the host has no native identity (including Cursor), supply `codexThreadId`, or
   use `gbot_bridge_start` once with `grokTarget`, `codexThreadId` and `expectedCwd`.
   An explicit binding forwards new visible Grok bot messages and returns Codex's
   corresponding terminal answer to Grok. Existing history is not replayed.
4. `mode: manual` with `reason: source-unavailable` preserves ordinary sending.
   Read `gbot_thread` later, using `after` for a known cursor and `full: true` only
   when entry bodies are needed. `replyMode: manual` explicitly requests this flow.

Automatic routes start a durable background worker that survives the calling tool.
Use `gbot_bridge_status` to distinguish delivery from execution and return delivery,
and to inspect gaps, paused routes and pending interactions. Do not resend unknown
submissions under a new identity. A provided `requestId` safely replays identical
tracked input; `controlRequestId` is returned independently of the gateway request ID.
`gbot_bridge_stop` stops a `bindingId`; `worker: true` explicitly stops the process.
Neither deletes receipts nor interrupts a Codex turn. No login service is installed;
if the process dies, the next tracked send/start resumes saved routes.

`gbot_codex_respond` is only for an explicit operator response to a current scoped
interaction. Copy the advertised interactionId, generation, threadId, turnId and
bindingId/exchangeId. Use one-time `decision: accept|decline|cancel`, or `answersJson`
with exact question IDs mapped to `{"answers":["answer"]}`. Never auto-approve,
change session permissions, or respond to an unsupported interaction; use its owning UI.

Bot replies are `send-message` entries; yours are `message` with `role: user`.

Grok-origin approvals are separate from Codex interactions. `gbot_grok_approvals`
(CLI: `gbot approvals list TARGET`) lists pending auto-review and local-tool cards in
the latest 200 entries. Linked/tracked routes forward new pending cards as notices;
their chat answers never authorize an action. After an explicit user decision, use
`gbot_grok_respond` (CLI: `gbot approvals respond --target TARGET --entry-id ID
--request-id ID --decision accept|decline`). Copy the exact IDs from the current
card. Accept grants once; persistent grants are unavailable. Responses recheck the
card before sending; delivery success does not prove execution. Older cards,
cookie/payment approvals and other unsupported requests require the owning Grok UI.

List targets with `gbot bots list` / `gbot groups list` when the name is ambiguous.

## CLI automation

The bundled `gbot` and `gbot-install` executables require Node.js 22.19.0 or newer.
For `gbot send`, `gbot codex status`, and `gbot codex send` with `--json`, read the result
document from stdout and branch on its `exitCode`, `mode`, `reason`, and `delivery`.
Framework argument/schema errors use stderr and exit 2. `--json` is reserved before
`--`; put `--` before flag-like message text.

## Auth

Same order as `gbot`: `GROK_BOT_GATEWAY_URL` plus `GROK_BOT_GATEWAY_TOKEN`,
else the Grok Bot app session, else `CURSOR_ACCESS_TOKEN`. `gbot doctor` shows
which source is present.

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
background reply routing uses the managed tools above. `codex_send` with `replyToGrok` or `bindingId` returns its terminal answer automatically; without either it retains the explicit observation flow. Managed routes default to guarded steering; ordinary sends still reject busy work by default.

`gbot codex bridge start/status/stop/respond` provide the same administration controls.
CLI auto-routing requires explicit `gbot send --reply-mode auto --codex-thread-id ID`.
`bridge run` is foreground and bounded (`--lifetime-ms`, default/maximum 23 hours).
The packaged `scripts/gbot-relay.mjs` is the unlimited foreground service entry.
Grok participation is through its gateway conversation, not an assumed native Grok
plugin loader or remote MCP tunnel. Never claim a host loaded a plugin from generated
configuration alone.

Managed Codex return routes reject `expectedTurnId` and legacy `replyTo`/`envelope`
options before submission; use plain `codex_send` for a caller-selected turn guard.
An explicit Grok target supplied with `bindingId` must resolve to the binding's
recipient. A mismatch fails instead of selecting one destination silently.

## Claude Code channel

`claude_send` sends to a named live Claude Code session on this machine and waits
for its explicit `claude_reply`. The destination must enable the native
`claude-channel` with `GROK_BOT_CLAUDE_CHANNEL=NAME` and Claude's development-channel
opt-in. Supply `name`, `message`, and optional `timeoutMs` (1..120000). `replied`
means the reply tool ran; `unknown` is not rejection and must not be automatically
retried. Normal Claude tool approvals remain in its session. This does not attach
to arbitrary Claude Desktop chats or connect a remote Grok runtime to local tools.
CLI: `gbot claude send NAME "message" --json`.

## Host tool inventory

Codex MCP clients receive Grok messaging and approval tools; truthfully identified
Grok Bot clients receive Codex messaging and approval tools. Bridge start/status/stop
remain shared. Cursor and unknown clients retain both sets. Filtering uses negotiated
client-name prefixes and does not provide authorization. A Grok runtime identifying
itself as Cursor needs its native MCP identity corrected before this filter applies.
