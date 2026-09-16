# Codex Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose thread discovery, guarded messaging and accurate completion receipts through generated plugin/MCP tools and CLI, as the shared foundation of an automatic Grok↔Codex relay.

**Architecture:** A conversation wrapper scopes the persistent client to a thread and reconciles bounded history. Existing submit logic is shared by one-shot and persistent callers. Agent Bundle projects the same result/progress contract onto MCP tools, generated plugins and CLI commands. A following task owns the managed automatic relay; this task is not the complete user experience.

**Tech Stack:** Node.js >=22.19.0, JavaScript/JSDoc core, TypeScript/TSX routes, node:test and existing route tests; Codex 0.154.0.

**Spec:** docs/superpowers/specs/2026-09-15-codex-conversation-design.md

## Global Constraints

- No new dependency, no second daemon, no private Desktop API, no global permission change.
- Preserve accepted/rejected/queued/unknown submission semantics, allowlists and provenance.
- Observers never refuse or approve requests; waiting never interrupts work.
- Scratch sockets and explicit test environments for tests; preserve existing send behavior.

### Task 1: Conversation collector, guarded messaging and plugin/MCP surfaces

**Files:** Create `src/core/codex/conversation.js`, `test/codex-conversation.test.js`, `src/cli/codex/watch.tsx`, `src/cli/codex/wait.tsx`. Modify `src/core/codex-bridge.js` only to share existing submission behavior, `src/cli/codex/send.tsx`, `tests/route-unit/tools.test.ts` when appropriate, and add a feature changeset. Create the four `src/mcp/grok-bot/tools/codex_{threads,send,wait,watch}.tsx` routes and shared TypeScript adapters/schemas if useful. Update `src/skills/talk-to-grok-bot/SKILL.md`; tests for generated MCP may live under `test/`. Shared socket fixture code may live under `test/helpers/`. Do not change the existing gbot_send route yet (next task owns automatic reply routing).

**Interfaces:** Consume `openCodexSession(env,options)` and the transport listeners. Produce exactly the `openCodexConversation`, send/wait/watch/close contracts in the named spec. A supplied session is shared and must not be closed by an individual conversation.

- [ ] Write failing tests with a fake daemon where `turn/start` sends completion before its acknowledgment and where a resumed turn is already completed. Assert observable outputs:

```js
const conversation = await openCodexConversation('thread-1', {env,expectedCwd:cwd});
const sent = await conversation.send('hello', {envelope});
const result = await conversation.wait({turnId:sent.turnId,messageId:sent.messageId});
assert.equal(sent.delivery, 'accepted');
assert.equal(result.execution.state, 'completed');
assert.equal(result.reply.text, 'final answer');
assert.deepEqual(result.reply.items.map(x => x.id), ['final-1']);
await conversation.close();
```

Construct literal mixed commentary/final/reasoning fixtures, failed/empty turns, repeated pagination cursors and foreign request IDs. Run the new test file and record expected failures before implementing.

- [ ] Implement the bounded collector, history reconciliation, shared-session ownership and canonical send delegation. Separate timeout/abort from turn interruption. Validate IDs, cwd, page shapes, timeouts and output budgets; retain correlation on uncertain outcomes.
- [ ] Add MCP discovery/send/wait/watch routes with actual socket-backed invocation tests and generated-server tools/list/call coverage. Implement explicit expected-turn guarded steering without fallback or observer auto-approval. Validate generated plugin artifacts and update installed skill descriptions.
- [ ] Add CLI routes/flags with `signal`, result-derived exits, render budget and framework progress. Ensure these actual commands work after building:

```sh
gbot codex watch --timeout-ms 1000 --max-events 20 THREAD_ID --json
gbot codex wait --timeout-ms 1000 THREAD_ID TURN_ID --json
gbot codex send --wait --timeout-ms 1000 THREAD_ID hello --json
```

- [ ] Test that an accepted send followed by timeout is still `delivery: accepted`, has `execution.state: timeout`, and exits nonzero; a plain send retains its previous immediate receipt. Test command discovery/validation against the built CLI, not package metadata.
- [ ] Run `npm run check`, inspect the diff for duplicated submission logic and unbounded retained state, commit owned files and report exact test output. Parent will review before the durable binding consumes this API.
