# Busy-thread delivery for `gbot codex send`

Decision record for [#38](https://github.com/ScriptedAlchemy/grok-bot-cli/issues/38). Evidence is the
app-server schema emitted by `codex app-server generate-json-schema` for codex-cli 0.154.0, the release
`src/codex-bridge.js` is pinned to.

## What the protocol offers

| Surface | In 0.154.0 | Notes |
| --- | --- | --- |
| `turn/start` on an idle thread | client request | Starts a new turn; `TurnStartResponse.turn.id` is the new turn. |
| `turn/start` on an **active** thread | client request | Steers the running turn. `TurnStartParams.turnTrigger` is documented as "Ignored when this request steers an already-active turn", so the call does not queue behind the human's turn — it joins it. |
| `turn/steer` | client request | Explicit steer; requires `expectedTurnId` and fails when it no longer matches the active turn. |
| `turn/interrupt` | client request | Stops the active turn. |
| `thread/queue/changed` | server notification | Emitted when the server-side queue changes. |
| `QueuedSubmission` | type | `{ id, clientUserMessageId, input }` — the shape of a queued item. |
| `thread/queue/add` (or any client request that enqueues) | **absent** | No `ClientRequest` variant adds to the queue; queueing is something Codex's own front ends do around `turn/start`. |
| `ThreadStatus` | type | `notLoaded`, `idle`, `active` (with `activeFlags`: `waitingOnApproval`, `waitingOnUserInput`), `systemError`. |

## Decision

1. **Refuse busy destinations.** `send` resumes the thread (`thread/resume`, `excludeTurns: true`) and reads
   `thread.status`. `active` → `delivery: "rejected", reason: "busy"`; `systemError` → `reason: "thread-error"`.
   Nothing is sent. `turn/steer` and `turn/interrupt` are never called: they change or stop work a human may be
   doing in the same thread, which #38's acceptance rules out.
2. **No local queue.** A `gbot`-side queue would live in one process on one machine, be lost on restart,
   reorder against the human's own submissions, and still race the same `turn/start` boundary. The server
   already has a queue (`QueuedSubmission`, `thread/queue/changed`); when a client request to add to it lands
   upstream, `gbot` should call that rather than emulate it. Until then the caller decides when to resend.
3. **Receipts distinguish states.** `accepted` (turn started; `turnId`, `turnStatus`), `rejected` (nothing left
   `gbot`; `reason` says why), `unknown` (the request left but no acknowledgment came back; `messageId` is
   Codex's `clientUserMessageId`, so the caller can look for it before resending). There is no `queued` state
   because `gbot` cannot enqueue, and no `completed` state because `send` returns once the turn starts —
   waiting for a reply is a separate bounded operation (`gbot codex list-threads`, or the thread itself).
4. **Experimental APIs stay off.** `turn/steer`, `turn/interrupt`, realtime, and queue notifications are not
   exposed. Adding any of them is a new flag plus a schema re-pin, not a default.

## Known ceiling

Status is read at resume time and `turn/start` follows on the same connection a few milliseconds later. A
human who starts a turn inside that window turns our `turn/start` into a steer. The daemon exposes no
start-only or compare-and-start request, so the race cannot be closed client-side; it is small, and the
receipt's `turnId` plus `clientUserMessageId` make it auditable after the fact. Re-evaluate when upstream
ships an enqueue request or a `turn/start` precondition.

## Test matrix (`test/codex-bridge.test.js`)

- idle → `accepted`, `turn/start` carries `clientUserMessageId` and `turnTrigger: "gbot"`.
- active (`waitingOnUserInput`) → `busy`, no `turn/start`/`turn/steer`/`turn/interrupt` sent.
- systemError → `thread-error`.
- active writer elsewhere → `external-owner`; unknown thread → `unknown-thread`.
- connection dropped after `turn/start` left → `delivery: "unknown"`, `reason: "transport"`, receipt keeps `messageId`.
- malformed acknowledgment → `delivery: "unknown"`, `reason: "bad-response"`.
