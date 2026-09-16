import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { openRelayEngine } from "../src/core/relay/engine.js";
import { openRelayState } from "../src/core/relay/state.js";
import { createIntake } from "../src/core/relay/intake.js";
import { createRecordFactory, op } from "../src/core/relay/records.js";
import { fakeAppServer } from "./helpers/codex-server.js";

async function fixture(t) {
  const dir = await mkdtemp("/tmp/relay-auth-recovery-");
  let now = 1000,
    auth = null,
    reads = 0,
    engine;
  const baseline = { id: "baseline", kind: "note", text: "old" };
  let page = [baseline];
  const sends = [],
    items = [];
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) =>
      ok({ thread: { id: p.threadId, cwd: "/tmp", status: { type: "idle" } } }),
    "thread/turns/list": (_, ok) =>
      ok({
        data: items.length ? [{ id: "turn", status: "completed" }] : [],
        nextCursor: null,
      }),
    "thread/items/list": (_, ok) =>
      ok({
        data: items.map((item) => ({ turnId: "turn", item })),
        nextCursor: null,
      }),
    "turn/start": (p, ok) => {
      items.push(
        { id: "user", type: "userMessage", clientId: p.clientUserMessageId },
        {
          id: "answer",
          type: "agentMessage",
          phase: "final_answer",
          text: "final",
        },
      );
      ok({ turn: { id: "turn", status: "inProgress" } });
    },
  });
  const gateway = {
    resolve: async (id) => ({ id }),
    tail: async (id) => {
      if (id === "target") reads++;
      if (auth)
        throw Object.assign(new Error("authentication rejected"), {
          status: auth,
        });
      return id === "target" ? page : [baseline];
    },
    send: async (id, text, extra) => {
      sends.push({ id, text, ...extra });
      return { delivery: "unknown" };
    },
  };
  const clock = () => now,
    options = {
      stateDir: dir,
      profile: "auth-fixture",
      env: { CODEX_HOME: fake.home },
      gateway,
      clock,
    };
  engine = await openRelayEngine(options);
  t.after(async () => {
    await engine?.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  const unknown = await engine.sendToGrok({
    grokTarget: "uncertain-target",
    codexThreadId: "source",
    message: "uncertain",
    requestId: "uncertain",
  });
  await engine.startBinding({ grokTarget: "target", codexThreadId: "linked" });
  return {
    get engine() {
      return engine;
    },
    get reads() {
      return reads;
    },
    sends,
    fake,
    unknown,
    baseline,
    set time(value) {
      now = value;
    },
    set auth(value) {
      auth = value;
    },
    set page(value) {
      page = value;
    },
    async restart({ legacy = false, forceBeforeDeadline = false } = {}) {
      await engine.close();
      if (legacy || forceBeforeDeadline) {
        const state = await openRelayState({ dir, profile: "auth-fixture" });
        if (legacy)
          await state.commit([
            op("targets", {
              ...state.read().targets.target,
              state: "paused",
              reason: "auth",
            }),
          ]);
        if (forceBeforeDeadline) {
          const intake = createIntake({
            state,
            gateway,
            clock,
            newRecord: createRecordFactory({ env: {}, clock }).newRecord,
            stoppedBindings: new Set(),
          });
          await intake.poll("target", true);
        }
        await state.close();
      }
      engine = await openRelayEngine(options);
    },
  };
}

for (const status of [401, 403])
  for (const legacy of [false, true])
    test(
      `auth ${status} recovers ${legacy ? "persisted paused" : "backoff"} target on deadline without duplicate intake or uncertain resend`,
      { timeout: 10000 },
      async (t) => {
        const f = await fixture(t);
        f.auth = status;
        await f.engine.tick();
        let target = f.engine
          .status()
          .targets.find((target) => target.id === "target");
        if (!legacy) assert.equal(target.state, "backoff");
        assert.equal(target.reason, "auth");
        assert.equal(target.cursor, "baseline");
        assert.equal(target.nextPoll, 2000);
        f.time = 1999;
        let reads = f.reads;
        await f.restart({ legacy, forceBeforeDeadline: true });
        await f.engine.tick();
        assert.equal(f.reads, reads);
        for (let failure = 1; failure <= 6; failure++) {
          f.time = target.nextPoll;
          const attemptedAt = target.nextPoll;
          await f.engine.tick();
          target = f.engine
            .status()
            .targets.find((target) => target.id === "target");
          assert.equal(target.state, "backoff");
          assert.equal(target.reason, "auth");
          assert.equal(target.cursor, "baseline");
          assert.equal(
            target.nextPoll - attemptedAt,
            Math.min(30000, 1000 * 2 ** failure),
          );
          reads = f.reads;
          f.time = target.nextPoll - 1;
          await f.engine.tick();
          assert.equal(f.reads, reads);
        }
        f.auth = null;
        f.page = [
          f.baseline,
          {
            id: "fresh",
            kind: "send-message",
            requestId: "new-request",
            text: "new message after auth restore",
          },
        ];
        f.time = target.nextPoll;
        await f.engine.tick();
        assert.equal(
          f.engine.status().targets.find((target) => target.id === "target")
            .state,
          "running",
        );
        assert.equal(
          f.engine.status().targets.find((target) => target.id === "target")
            .cursor,
          "fresh",
        );
        assert.equal(
          f.engine.status().targets.find((target) => target.id === "target")
            .reason,
          null,
        );
        await f.engine.tick();
        await f.restart();
        await f.engine.tick();
        assert.equal(
          f.fake.received.filter((x) => x.method === "turn/start").length,
          1,
        );
        assert.equal(
          f.engine
            .status()
            .receipts.find((x) => x.exchangeId === f.unknown.exchangeId)
            .delivery,
          "unknown",
        );
        assert.equal(
          f.sends.filter((x) => x.clientNonce === f.unknown.clientId).length,
          1,
        );
      },
    );
for (const status of [401, 403])
  test(
    `auth ${status} restore with missing cursor pauses as gap and never resets coverage`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      f.auth = status;
      await f.engine.tick();
      f.time = f.engine
        .status()
        .targets.find((target) => target.id === "target").nextPoll;
      f.auth = null;
      f.page = [
        {
          id: "uncovered",
          kind: "send-message",
          requestId: "gap-request",
          text: "must not replay",
        },
      ];
      await f.engine.tick();
      const target = f.engine
        .status()
        .targets.find((target) => target.id === "target");
      assert.equal(target.state, "paused");
      assert.equal(target.reason, "gap");
      assert.equal(target.cursor, "baseline");
      assert.equal(target.observedCursor, "uncovered");
      const reads = f.reads;
      f.page = [
        f.baseline,
        {
          id: "later",
          kind: "send-message",
          requestId: "later-request",
          text: "still paused",
        },
      ];
      f.time += 60000;
      await f.restart();
      await f.engine.tick();
      assert.equal(f.reads, reads);
      assert.equal(
        f.fake.received.filter((x) => x.method === "turn/start").length,
        0,
      );
      assert.equal(
        f.sends.filter((x) => x.clientNonce === f.unknown.clientId).length,
        1,
      );
    },
  );
