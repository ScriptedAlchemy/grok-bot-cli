import assert from "node:assert/strict";
import test from "node:test";
import { createRelayCodex } from "../src/core/relay/codex.js";

test("failed session reconnect backs off with a bounded clock", async () => {
  let calls = 0,
    now = 0;
  const c = createRelayCodex({
    env: {},
    read: () => ({ records: {} }),
    clock: () => now,
    openSession: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  await assert.rejects(c.verify({ threadId: "t" }));
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 1);
  now = 1000;
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 2);
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 2);
  now = 3000;
  await assert.rejects(c.verify({ threadId: "t" }));
  assert.equal(calls, 3);
  await c.close();
});
test("steer retries only definite stale guards and never falls back to turn/start", async () => {
  let tries = 0;
  const sends = [];
  const session = {
    client: {
      closed: false,
      onClose: () => {},
      close() {},
      request: async () => ({
        data: [{ id: "active", status: "inProgress" }],
        nextCursor: null,
      }),
    },
  };
  const c = createRelayCodex({
    env: {},
    read: () => ({ records: {} }),
    openSession: async () => session,
    openConversation: async () => ({
      close() {},
      cwd: process.cwd(),
      send: async (_, options) => {
        sends.push(options);
        tries++;
        return {
          delivery: "rejected",
          reason: "rejected",
          error: "expected turn guard mismatch",
        };
      },
    }),
  });
  const record = {
    threadId: "thread",
    expectedCwd: process.cwd(),
    busyPolicy: "steer",
    clientId: "client",
    correlationId: "corr",
    hop: 0,
    maxHops: 4,
    text: "message",
  };
  assert.equal((await c.send(record)).delivery, "rejected");
  assert.equal(tries, 3);
  assert.ok(sends.every((s) => s.whenBusy === "steer"));
  await c.close();
});
