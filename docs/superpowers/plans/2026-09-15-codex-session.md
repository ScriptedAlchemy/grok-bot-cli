# Persistent Codex Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a bounded, persistent app-server connection that can deliver events and serve as the foundation for completion waiting and a recoverable Grok binding.

**Architecture:** Extend the existing Unix WebSocket implementation. Preserve one-shot send behavior and expose its existing initialization path. Keep conversation scheduling and durable delivery state outside the transport.

**Tech Stack:** JavaScript/JSDoc, Node.js >=22.19.0, node:test, existing Agent Bundle build; app-server schema 0.154.0.

**Spec:** docs/superpowers/specs/2026-09-15-codex-session-design.md

## Global Constraints

- No new dependencies or Desktop/private-pipe APIs.
- Preserve current envelope, route, receipt, busy and approval ownership contracts.
- One writer owns `src/core/codex-bridge.js` during this task.
- Use scratch Unix sockets and explicit test env; no live gateway messages in unit tests.
- Failures after a submission cannot be mislabeled as rejected deliveries.

### Task 1: Event-capable persistent transport

**Files:** Modify `src/core/codex-bridge.js`; create `test/codex-session.test.js`. A focused `src/core/codex/transport.js` extraction is permitted only if needed to keep the transport understandable, with compatibility re-exports from `codex-bridge.js`. Do not modify CLI routes, existing test files, gateway modules or package metadata.

**Interfaces:** Keep `connectCodexAppServer(path, options)` and add the listener/response APIs defined in the spec. Export `openCodexSession(env, options)` as the canonical initialized persistent connection. Existing send/list/status callers keep their behavior.

- [ ] Write failing tests using a scratch Unix HTTP Upgrade server. The minimum observable cases are:

```js
const seen = [];
const off = client.onNotification(message => seen.push(message));
// Server sends two notification frames in one write.
assert.deepEqual(seen.map(x => x.method), ['turn/started', 'turn/completed']);
off();
// Later notifications must not reach this listener.

client.onServerRequest(request => client.respond(request.id, {decision: 'decline'}));
// The peer receives exactly one matching response; a duplicate local respond throws.
assert.throws(() => client.respond('already-resolved', {}));

const closed = new Promise(resolve => client.onClose(resolve));
// Destroy the idle peer without a pending request.
assert.match((await closed).message, /closed|disconnect|socket/i);
await assert.rejects(client.request('thread/list', {}));
```

Also test AbortSignal cleanup, observer silence on foreign approvals, post-resolution response refusal, absolute limits on outgoing writes and remembered requests, a throwing listener, and notification listeners passed at connection construction. Tests must distinguish a healthy idle connection from a dead one and use short injected test deadlines.

- [ ] Run `TMPDIR=/tmp GROK_BOT_TEST=1 node --test test/codex-session.test.js` and record the expected failures.
- [ ] Implement event dispatch in `onMessage`, close notification in all cleanup paths, bounded registration/request state, safe response methods and the exported initialization path. Validate numeric limits and timeouts. Attach initial hooks before any bytes can be handled. Maintain existing refusal semantics for legacy one-shot callers.
- [ ] Run the new test file, then `npm run build` and `TMPDIR=/tmp GROK_BOT_TEST=1 node --test test/codex-bridge.test.js test/codex-session.test.js`.
- [ ] Self-review for resource leaks, unbounded state and changed legacy delivery semantics. Commit only the task-owned implementation/test files and write the report with test commands and results.

## Continuation roadmap

The controller continues without another user checkpoint: completion waiting and watch commands; atomic delivery ledger and one foreground binding; explicit steering/operator interaction and optional supervision; live loop/recovery proofs; final review, merge and release verification. Each continuation gets its own task brief after the preceding interfaces are verified.
