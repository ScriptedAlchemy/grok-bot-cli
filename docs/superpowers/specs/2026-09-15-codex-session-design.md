# Persistent Codex session design

This implements the first part of the Grok↔Codex design approved by Zack's request to do all next steps. Keep the existing managed daemon and gateway. The later binding will consume this session layer; it will not run another Codex engine.

## Contract

Extend the existing WebSocket-over-Unix-socket client with synchronous registration methods `onNotification(listener)`, `onServerRequest(listener)`, and `onClose(listener)`, each returning an unsubscribe function. Notifications carry the original `{method, params}` object. Server requests carry original `{id, method, params}`. Close listeners receive an Error explaining closure, once. Registration after closure must still expose closed state (through `closed` and/or immediate close callback). Constructor options may install the three listeners before connection/initialization messages arrive.

Keep request/notify/close and the existing one-shot refusal/ownership behavior working. New passive listeners must never reject another client's approval. Add `respond(id, result)` and `rejectRequest(id, error)` for pending server requests; reject duplicate or resolved IDs locally. Clear pending request ownership on `serverRequest/resolved` and connection close. The high-level session will enforce thread/turn ownership and method-specific response validation before invoking these low-level methods.

Expose the existing initialization path as `openCodexSession(env, options)` returning `{client, path, init}`. It must use the same socket selection, route checks, initialize validation, version identity and cleanup as today's `openSession`. Support `signal`, `timeoutMs`, `experimental`, and initial event listeners. Keep existing internal callers compatible.

## Resource and lifecycle limits

- Retain 16 KiB upgrade header, 4 MiB message and 8 MiB aggregate receive bounds and absolute handshake/RPC deadlines.
- Outbound encoded frames and queued socket bytes must fit an 8 MiB budget; a nonreading peer must cause a visible bounded failure. Await/drain or fail rather than silently accumulating writes.
- Bound outstanding client requests and remembered server requests/refusals/deferred requests to 128 each. Exceeding a bound closes the connection with an explicit error and rejects pending operations.
- Close on protocol errors; complete cleanup on abort and local/remote close. No new requests after closure. Dispose listeners and pending timers; no unhandled rejection or process-level exception from a throwing listener.
- Idle healthy connections survive the RPC timeout. Disconnection must notify observers even when no RPC is pending. Local close must not stop the daemon or other clients.
- No new dependency, no raw private Desktop pipes, no Desktop patch, and no daemon/global permission change.

## Validation

Use real Unix socket fake servers for framing and lifecycle tests. Verify notification ordering, listener disposal, pending server request response exactly once, resolution invalidation, listener failure, abort, idle disconnect, request-after-close, bounded outgoing pressure and server-request floods. Retain the existing codex bridge suite, including its one-shot ownership tests. A live metadata-only probe may connect two clients to the existing daemon; no model prompt is needed for this layer.
