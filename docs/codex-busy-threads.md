# Busy-thread delivery for `gbot codex send`

Decision record for [#38](https://github.com/ScriptedAlchemy/grok-bot-cli/issues/38). Evidence is the
app-server schema emitted by `codex app-server generate-json-schema` for codex-cli 0.154.0 — the release
`src/codex-bridge.js` is pinned to — generated both without and with `--experimental`, plus a live probe
against a 0.154.0 daemon (below).

## What the protocol offers

| Surface | In 0.154.0 | Notes |
| --- | --- | --- |
| `turn/start` on an idle thread | stable client request | Starts a new turn; `TurnStartResponse.turn.id` is the new turn. |
| `turn/start` on an **active** thread | stable client request | Steers the running turn. `TurnStartParams.turnTrigger` is documented as "Ignored when this request steers an already-active turn", so the call does not queue behind the human's turn — it joins it. |
| `turn/steer` | stable client request | Explicit steer; requires `expectedTurnId` and fails when it no longer matches the active turn. |
| `turn/interrupt` | stable client request | Stops the active turn. |
| `thread/queue/add` / `list` / `update` / `delete` / `reorder` / `start` | **experimental** client requests | Present only in the `--experimental` schema and only for a client that initialized with `capabilities.experimentalApi: true`. `add` takes `{ threadId, clientUserMessageId, input }` and returns a `QueuedSubmission { id, clientUserMessageId, input }`; `list` pages with `cursor`/`limit`; `start` runs one queued submission as a turn. |
| `thread/queue/changed` | server notification | Emitted when a thread's queue changes. |
| `ThreadStatus` | type | `notLoaded`, `idle`, `active` (with `activeFlags`: `waitingOnApproval`, `waitingOnUserInput`), `systemError`. |

### Live probe (0.154.0 daemon, 2026-09-15)

With `experimentalApi: true`: `thread/queue/list` → `{ data: [], nextCursor: null }`; `thread/queue/add`
returned a `QueuedSubmission` with the supplied `clientUserMessageId`; `list` then showed it first in
insertion order; `thread/queue/delete` → `{ deleted: true }` and the list was empty again. The target
thread was `notLoaded` — the queue is server-side state, not a property of a loaded session. Not tested
on this machine: whether queued submissions survive a daemon restart, and whether the daemon starts them
itself when the active turn ends or only on `thread/queue/start` (the TUI drains its own queue; a
daemon-only thread may need an explicit start). Both stay documented as unknown until measured.

## Decision

1. **Default: refuse busy destinations.** `send` resumes the thread (`thread/resume`, `excludeTurns: true`)
   and reads `thread.status`. `active` → `delivery: "rejected", reason: "busy"`; `systemError` →
   `reason: "thread-error"`; any status this pin does not know → `reason: "unknown-status"`. Only `idle`
   and `notLoaded` (no turn can be running) proceed to `turn/start`. `turn/steer` and `turn/interrupt`
   are never called: they change or stop work a human may be doing in the same thread.
2. **Opt-in: hand busy sends to the daemon's queue.** `--when-busy queue` requires
   `GROK_BOT_CODEX_EXPERIMENTAL=1` (the experimental API is gated, so its use is an operator decision, not
   a default) and initializes the session with `experimentalApi: true`. On an `active` thread `send` calls
   `thread/queue/add` with the envelope's `messageId` as `clientUserMessageId` and returns
   `delivery: "queued"` with `queuedSubmissionId`. A daemon without the method answers `-32601`, reported
   as `reason: "unsupported"`. `gbot codex queue <threadId>` lists the queue (same gate) so the caller can
   see whether the submission is still waiting. Idle threads are never queued — they start directly.
3. **No gbot-side queue.** A local queue would live in one process on one machine, be lost on restart,
   and race the human's own submissions. The daemon's queue is the right owner; when it stabilizes the
   gate goes away.
4. **Receipts distinguish states.** `accepted` (turn started; `turnId`, `turnStatus`), `queued`
   (`queuedSubmissionId`; not started), `rejected` (nothing left `gbot`; `reason` says why), `unknown`
   (the request left but no acknowledgment came back; `messageId` is Codex's `clientUserMessageId`, so
   the caller can look for it in the thread or the queue before resending). There is no `completed`
   state: `send` returns when the turn starts, and waiting for a result is a separate bounded operation.
5. **Steer and interrupt stay out.** Adding either is a new flag plus a schema re-pin, never a default.

## Known ceiling

Status is read at resume time and `turn/start` follows on the same connection a few milliseconds later.
A human who starts a turn inside that window turns our `turn/start` into a steer. The daemon exposes no
compare-and-start request, so the race cannot be closed client-side; it is small, and the receipt's
`turnId` plus `clientUserMessageId` make it auditable. The upgrade path is `thread/queue/add` followed by
`thread/queue/start` once the queue API leaves experimental.

## Test matrix (`test/codex-bridge.test.js`)

- idle → `accepted`, `turn/start` carries `clientUserMessageId` and `turnTrigger: "gbot"`.
- active (`waitingOnUserInput`) → `busy`, no `turn/start` / `turn/steer` / `turn/interrupt` sent.
- active + `--when-busy queue` + gate on → `queued`, `initialize` carried `experimentalApi: true`,
  `thread/queue/add` carried the envelope id; `gbot codex queue` lists and sanitizes; a daemon without the
  method → `unsupported`.
- `--when-busy queue` with the gate off → `experimental-disabled`, nothing sent.
- systemError → `thread-error`; unknown status → `unknown-status`.
- active writer elsewhere → `external-owner`; unknown thread → `unknown-thread`.
- connection dropped after `turn/start` left → `delivery: "unknown"`, `reason: "transport"`, receipt keeps `messageId`.
- malformed acknowledgment → `delivery: "unknown"`, `reason: "bad-response"`.
- every rejection, including route and allowlist refusals, carries `messageId` / `correlationId` / `hop`.
