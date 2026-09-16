# Managed Grokbot and Codex relay implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, task review before dependent implementation.

**Goal:** Deliver Grokbot↔Codex messages and replies automatically through generated plugins/MCP while callers continue working.
**Spec:** docs/superpowers/specs/2026-09-15-managed-relay-design.md
**Architecture:** One durable relay engine and single-writer state store; managed local worker provides the same API to MCP and CLI. Existing gateway, app-server and conversation contracts remain canonical.
**Constraints:** No private Desktop interfaces or global permission edits. Unknown delivery never blindly retries. No automatic approvals. Exact observed source identity or explicit route. Bounded state and explicit coverage gaps. Parent owns live calls.

### Task 1: Durable conversation relay engine

**Files:** Create `src/core/relay/state.js`, `src/core/relay/engine.js` and focused helper modules if needed, `test/relay-state.test.js`, `test/relay-engine.test.js`, optional `test/helpers/` fixtures. May add narrowly needed public conversation/history helpers in `src/core/codex/conversation.js` with tests; avoid duplicated protocol logic. Do not modify surface routes, runtime config or package files in this task.

- [ ] Read exact spec and reviewed conversation interfaces; write failing state/engine tests for automatic request replies and explicit linked Grok→Codex→Grok return.
- [ ] Implement a bounded, validated relay adapter over the existing Agent Bundle SQLite state kernel (do not duplicate its journal/transaction code) and intake/receipt/checkpoint transitions, scoped transcript correlation and echo prevention.
- [ ] Implement bounded reconciliation after uncertain sends/restarts, guarded active delivery, output coalescing and completion, and cancellation/backoff/visible pause behavior.
- [ ] Expose bounded status and generation-scoped interactions, method-specific response validation without auto-approval.
- [ ] Prove duplicate polling, crash boundaries, missing cursors, empty startup, out-of-order correlation, state bounds/corruption, own-response echo suppression, foreign/stale requests and disconnect behavior using fixtures. Test expected failures before fixes.
- [ ] Run affected core and conversation suites plus typecheck/build; self-review, commit owned files and report. Parent reviews before Task2 consumes API.

### Task 2: Managed worker and fluid plugin/MCP experience

**Files:** Create process/control modules in `src/core/relay/`, built worker entry `src/gbot-relay.ts` or equivalent; modify `agent-bundle.config.ts` only to package worker, `src/mcp/grok-bot/tools/gbot_send.tsx`, `codex_send.tsx`, new bridge start/status/stop/respond tools, shared TS adapter/schema module, CLI bridge routes and explicit gbot send auto-route options. Update installed skill, README, feature changeset and route/packed-worker tests.

- [ ] Write failing generated MCP tests for native source identity automatic routing, source-unavailable manual receipt and explicit return route, plus worker survival after caller exits and concurrent starts.
- [ ] Implement private bounded worker control protocol, verified startup/profile identity, stable mutation request IDs, concurrency-safe lifetime and foreground mode. Locate packaged worker correctly from CLI and generated MCP/host installations, including paths with spaces.
- [ ] Wire gbot_send automatic reply routing from native Codex lineage, explicit links and codex_send return routes. No silent fallback to untracked sending on worker failure. Add bridge lifecycle/status and explicit method-specific operator response surfaces.
- [ ] Verify actual packed stdio tool discovery/calls and persisted worker lifecycle against fixtures, all generated Codex/Cursor/portable artifacts, cancellation and compatibility of existing manual/CLI paths.
- [ ] Update installed skill and README to explain normal asynchronous delivery and one-time explicit binding, without claims beyond verified host support. Run full npm run check plus packed smoke at supported minimum Node22.19.0; self-review, commit, report. Parent performs live proof and whole-branch review before merge.
