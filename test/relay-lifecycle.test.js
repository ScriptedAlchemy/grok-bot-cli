import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelayEngine } from "../src/core/relay/engine.js";
import { openRelayState } from "../src/core/relay/state.js";
import { createRecordFactory, op } from "../src/core/relay/records.js";
import { fakeAppServer } from "./helpers/codex-server.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("reconciliation visits the observable 21st record after 20 unresolved records", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-reconcile-"));
  let engine;
  t.after(async () => {
    await engine?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const factory = createRecordFactory({ env: {}, clock: () => 1000 });
  const rows = Array.from({ length: 21 }, (_, i) => ({
    ...factory.newRecord(
      "codex",
      "record-" + String(i).padStart(2, "0"),
      {
        threadId: "thread",
        targetId: "target",
        expectedCwd: process.cwd(),
        busyPolicy: "steer",
      },
      "hello",
    ),
    submission: "unknown",
  }));
  const store = await openRelayState({ dir, profile: "fairness" });
  await store.commit(rows.map((r) => op("records", r)));
  await store.close();
  let queries = 0;
  const session = {
    client: {
      closed: false,
      onClose() {},
      close() {},
      async request() {
        queries++;
        return {
          data: [
            {
              turnId: "turn-21",
              item: { type: "userMessage", clientId: rows[20].clientId },
            },
          ],
          nextCursor: null,
        };
      },
    },
  };
  engine = await openRelayEngine({
    stateDir: dir,
    profile: "fairness",
    gateway: {},
    openSession: async () => session,
    openConversation: async () => ({
      cwd: process.cwd(),
      close() {},
      wait: async () => ({ execution: { state: "unknown" } }),
    }),
  });
  await engine.tick();
  assert.equal(queries, 20);
  assert.equal(
    engine.status().receipts.find((r) => r.exchangeId === rows[20].id).delivery,
    "unknown",
  );
  await engine.tick();
  assert.ok(queries <= 40);
  const receipt = engine
    .status()
    .receipts.find((r) => r.exchangeId === rows[20].id);
  assert.equal(receipt.delivery, "accepted");
  assert.equal(receipt.turnId, "turn-21");
  assert.equal(
    engine.status().receipts.filter((r) => r.delivery === "unknown").length,
    20,
  );
});

for (const phase of [
  "history",
  "idle-history",
  "idle-resume",
  "retry-history",
  "send-resume",
  "retry-resume",
  "written",
  "written-unknown",
])
  test(
    `stopping one binding during ${phase} preserves other routes and delivery certainty`,
    { timeout: 5000 },
    async (t) => {
      const reached = deferred(),
        release = deferred();
      let historyCalls = 0,
        resumeCalls = 0,
        steers = 0,
        gateResume = false;
      const hold = async (ok) => {
        reached.resolve();
        await release.promise;
        ok();
      };
      const idle = phase.startsWith("idle-");
      const turns = idle ? [] : [{ id: "turn", status: "inProgress" }];
      const submit = (p, ok, err) => {
        const reply = () =>
          ok(
            p.expectedTurnId
              ? {
                  turnId:
                    phase === "written-unknown" && p.threadId === "thread-1"
                      ? "wrong-turn"
                      : "turn",
                }
              : { turn: { id: "turn", status: "inProgress" } },
          );
        if (p.threadId === "thread-1") {
          steers++;
          if (phase === "retry-history" || phase === "retry-resume") {
            err({ code: -32600, message: "expected turn guard mismatch" });
            return;
          }
          if (phase.startsWith("written")) {
            void hold(reply);
            return;
          }
        }
        reply();
      };
      const fake = await fakeAppServer({
        initialize: (_, ok) => ok({}),
        "thread/resume": (p, ok) => {
          const reply = () =>
            ok({
              thread: {
                id: p.threadId,
                cwd: process.cwd(),
                status: { type: idle ? "idle" : "active" },
              },
              cwd: process.cwd(),
            });
          if (p.threadId === "thread-1" && gateResume) {
            resumeCalls++;
            if (
              (["send-resume", "idle-resume"].includes(phase) &&
                resumeCalls === 1) ||
              (phase === "retry-resume" && resumeCalls === 2)
            ) {
              void hold(reply);
              return;
            }
          }
          reply();
        },
        "thread/turns/list": (p, ok) => {
          if (p.threadId === "thread-1") {
            historyCalls++;
            gateResume = true;
            if (
              (["history", "idle-history"].includes(phase) &&
                historyCalls === 1) ||
              (phase === "retry-history" && historyCalls === 2)
            ) {
              void hold(() =>
                ok({
                  data: turns,
                  nextCursor: null,
                }),
              );
              return;
            }
          }
          ok({ data: turns, nextCursor: null });
        },
        "turn/steer": submit,
        "turn/start": submit,
      });
      const dir = await mkdtemp(join(tmpdir(), "relay-stop-"));
      const engine = await openRelayEngine({
        stateDir: dir,
        profile: "stop",
        env: { CODEX_HOME: fake.home },
        gateway: { resolve: async (id) => ({ id }), tail: async () => [] },
      });
      t.after(async () => {
        release.resolve();
        await engine.close();
        await fake.close();
        await rm(dir, { recursive: true, force: true });
      });
      const first = await engine.startBinding({
        grokTarget: "target-1",
        codexThreadId: "thread-1",
      });
      const second = await engine.startBinding({
        grokTarget: "target-2",
        codexThreadId: "thread-2",
      });
      const pending = engine.sendToCodex({
        bindingId: first.id,
        message: "stop me",
        requestId: "stop-race",
      });
      await reached.promise;
      const before = steers;
      await engine.stopBinding({ bindingId: first.id });
      release.resolve();
      const receipt = await pending;
      assert.equal(steers, before, "no submission after stop returns");
      assert.equal(
        receipt.delivery,
        phase === "written"
          ? "accepted"
          : phase === "written-unknown"
            ? "unknown"
            : "rejected",
      );
      if (!phase.startsWith("written"))
        assert.equal(receipt.reason, "cancelled");
      assert.ok(engine.status().generation);
      assert.equal(
        (
          await engine.sendToCodex({
            bindingId: second.id,
            message: "keep working",
          })
        ).delivery,
        "accepted",
      );
      assert.equal(
        fake.received.filter((r) => r.method === "turn/interrupt").length,
        0,
      );
    },
  );
