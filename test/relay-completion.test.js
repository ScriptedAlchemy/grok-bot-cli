import assert from "node:assert/strict";
import test from "node:test";
import { createCompletion } from "../src/core/relay/completion.js";
function fixture(count, sameTurn = false) {
  const data = {
      records: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          String(i),
          {
            id: String(i),
            kind: "codex",
            submission: "accepted",
            turnId: sameTurn ? "turn" : String(i),
            targetId: "target",
            threadId: "thread",
            execution: "pending",
            reason: null,
          },
        ]),
      ),
    },
    seen = [];
  const complete = createCompletion({
    state: { read: () => data },
    codex: {
      wait: async (r) => {
        seen.push(r.id);
        return { execution: { state: "unknown" } };
      },
    },
    update: async (id, patch) => Object.assign(data.records[id], patch),
    runnable: () => true,
  });
  return { complete, seen, data };
}
test("bounded completion scans rotate fairly through all pending turns", async () => {
  const f = fixture(21);
  await f.complete();
  await f.complete();
  assert.ok(f.seen.includes("20"));
});
test("oversized coalesced turn pauses visibly before collector anchor limit", async () => {
  const f = fixture(201, true);
  await f.complete();
  assert.equal(f.seen.length, 0);
  assert.ok(
    Object.values(f.data.records).every(
      (r) => r.execution === "paused" && r.reason === "capacity",
    ),
  );
});
