# Bridge administration and diagnostics

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

## Codex conversation tools

The generated Codex, Cursor, and Claude plugins and portable MCP artifact expose these
additional tools on the same `grok-bot` MCP server. Codex tools connect only to a
**local** Codex app-server control socket on the process's machine
(`$CODEX_HOME/...` or `CODEX_APP_SERVER_SOCK`). gbot has **no remote transport**.
When the MCP server runs on the Grok Bot agent box (`HOME=/home/box`), do not call
these tools — run the `gbot` CLI on the user's registered machine through Grok Bot
Shell with a machineId, after `codex app-server daemon start` (or bootstrap) there.
Grok tools use the Grok gateway. Portable MCP artifacts must be configured in an
MCP-capable host; they are not automatically loaded by the Grok app.

- `codex_threads`: discovery of daemon-managed Codex threads, newest activity first. `query` (name/title, preview or id prefix, all pages), `activeWithin`/`since`, `sort`/`order`, `cwd`, `modelProvider`, `sourceKind`, `archived`; `limit` is the page size (1-200) and `nextCursor` continues.
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

## CLI automation

The bundled `gbot` and `gbot-install` executables require Node.js 22.19.0 or newer.
`gbot-install install grokbot --json` reports its sideload into Grok Bot's
`scriptedalchemy/plugins` marketplace clone and plugin cache in the `sideload` field;
retarget it with `--sideload-repo`/`--sideload-slug` (`GROK_BOT_SIDELOAD_REPO`,
`GROK_BOT_SIDELOAD_SLUG`) or skip it with `--no-sideload` (`GROK_BOT_SIDELOAD=0`).
`gbot-install doctor --host grokbot` reports its state as `AB7335`.
For `gbot send`, `gbot codex status`, and `gbot codex send` with `--json`, read the result
document from stdout and branch on its `exitCode`, `mode`, `reason`, and `delivery`.
Framework argument/schema errors use stderr and exit 2. `--json` is reserved before
`--`; put `--` before flag-like message text.

## Host tool inventory

Codex MCP clients receive Grok messaging and approval tools; truthfully identified
Grok Bot clients receive Codex messaging and approval tools. Bridge start/status/stop
remain shared. Cursor and unknown clients retain both sets. Filtering uses negotiated
client-name prefixes and does not provide authorization. A Grok runtime identifying
itself as Cursor needs its native MCP identity corrected before this filter applies.
