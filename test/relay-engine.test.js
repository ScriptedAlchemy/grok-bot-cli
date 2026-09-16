import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAppServer } from "./helpers/codex-server.js";

async function fixture(
  t,
  {
    active = false,
    finalStatus = "completed",
    finalText = "Codex answer",
    disconnect = false,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "relay-engine-"));
  const page = [],
    sent = [],
    items = [];
  let state = active ? "inProgress" : finalStatus;
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) =>
      ok({
        thread: {
          id: p.threadId,
          cwd: process.cwd(),
          status: { type: active ? "active" : "idle" },
        },
        cwd: process.cwd(),
      }),
    "thread/turns/list": (_, ok) =>
      ok({
        data: items.length || active ? [{ id: "turn-1", status: state }] : [],
        nextCursor: null,
      }),
    "thread/items/list": (_, ok) =>
      ok({
        data: items.map((item) => ({ turnId: "turn-1", item })),
        nextCursor: null,
      }),
    "turn/start": (p, ok, err, send, socket) => {
      items.push({
        id: "u" + items.length,
        type: "userMessage",
        clientId: p.clientUserMessageId,
      });
      items.push({
        id: "a" + items.length,
        type: "agentMessage",
        phase: "final_answer",
        text: finalText,
      });
      if (disconnect) {
        socket.destroy();
        return;
      }
      ok({ turn: { id: "turn-1", status: "inProgress" } });
    },
    "turn/steer": (p, ok) => {
      items.push({
        id: "u" + items.length,
        type: "userMessage",
        clientId: p.clientUserMessageId,
      });
      ok({ turnId: p.expectedTurnId });
    },
  });
  const gateway = {
    resolve: async (ref) => ({ id: ref, name: "Fixture" }),
    tail: async () => page.slice(-200),
    send: async (targetId, text, extra) => {
      sent.push({ targetId, text, ...extra });
      return { delivery: "unknown" };
    },
  };
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  let engine = await openRelayEngine({
    stateDir: dir,
    profile: "fixture",
    env: { CODEX_HOME: fake.home },
    gateway,
    clock: () => 1000,
  });
  t.after(async () => {
    await engine.close();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    get engine() {
      return engine;
    },
    page,
    sent,
    items,
    fake,
    complete() {
      state = "completed";
      items.push({
        id: "last",
        type: "agentMessage",
        phase: "final_answer",
        text: "Combined answer",
      });
    },
    async restart() {
      await engine.close();
      engine = await openRelayEngine({
        stateDir: dir,
        profile: "fixture",
        env: { CODEX_HOME: fake.home },
        gateway,
        clock: () => 1000,
      });
    },
  };
}
test("linked empty baseline forwards once, returns final and suppresses out-of-order own echo", async (t) => {
  const f = await fixture(t);
  await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
    requestId: "link",
  });
  f.page.push({
    id: "g1",
    kind: "send-message",
    requestId: "proactive",
    message: { content: "Hello Codex" },
  });
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Codex answer/);
  f.page.push(
    {
      id: "echo",
      kind: "send-message",
      requestId: "own",
      message: { content: "reply echo" },
    },
    {
      id: "outgoing",
      kind: "user",
      clientNonce: f.sent[0].clientNonce,
      requestId: "own",
    },
  );
  await f.engine.tick();
  await f.restart();
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(f.sent.length, 1);
});
test("tracked request uses actual requestId and never forwards another thread reply", async (t) => {
  const f = await fixture(t);
  const r = await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "Ask Grok",
    requestId: "ask",
  });
  assert.equal(r.delivery, "unknown");
  assert.equal(f.sent.length, 1);
  f.page.push(
    {
      id: "unrelated",
      kind: "send-message",
      requestId: "other",
      text: "ignore",
    },
    {
      id: "answer",
      kind: "send-message",
      requestId: "request / opaque",
      text: "The Grok answer",
    },
    {
      id: "user",
      kind: "user",
      clientNonce: f.sent[0].clientNonce,
      requestId: "request / opaque",
    },
  );
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(f.sent.length, 1);
  assert.match(
    f.fake.received.find((r) => r.method === "turn/start").params.input[0].text,
    /The Grok answer/,
  );
  await f.restart();
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "Ask Grok",
    requestId: "ask",
  });
  assert.equal(f.sent.length, 1);
});
test("missing cursor pauses and never replays reset snapshot", async (t) => {
  const f = await fixture(t);
  f.page.push({ id: "baseline", kind: "user" });
  await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
  });
  f.page.splice(0, 1, {
    id: "new",
    kind: "send-message",
    requestId: "r",
    text: "lost coverage",
  });
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    0,
  );
  assert.equal((await f.engine.status()).targets[0].reason, "gap");
});
test("active messages steer and coalesce a single anchored return", async (t) => {
  const f = await fixture(t, { active: true });
  f.items.push({
    id: "before",
    type: "agentMessage",
    phase: "final_answer",
    text: "Earlier final",
  });
  await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
  });
  f.page.push(
    { id: "one", kind: "send-message", requestId: "r", text: "one" },
    { id: "two", kind: "send-message", requestId: "r", text: "two" },
  );
  await f.engine.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/steer").length,
    2,
  );
  f.complete();
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Combined answer/);
  assert.doesNotMatch(f.sent[0].text, /Earlier final/);
});

test("same request ID rejects changed inputs and stopped bindings cease intake", async (t) => {
  const f = await fixture(t);
  const b = await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
    requestId: "bind",
  });
  await f.engine.sendToGrok({
    bindingId: b.id,
    message: "first",
    requestId: "same",
  });
  await assert.rejects(
    f.engine.sendToGrok({
      bindingId: b.id,
      message: "changed",
      requestId: "same",
    }),
    /Idempotency/,
  );
  assert.equal(f.sent.length, 1);
  await f.engine.stopBinding({ bindingId: b.id });
  f.page.push({
    id: "after-stop",
    kind: "send-message",
    requestId: "r",
    text: "stop",
  });
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    0,
  );
});
test("uncertain Codex submission is adopted by clientId after restart, never resent", async (t) => {
  const f = await fixture(t);
  const r = await f.engine.sendToCodex({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "direct",
    requestId: "direct",
  });
  await f.engine.close();
  const { openRelayState } = await import("../src/core/relay/state.js");
  const s = await openRelayState({
    dir: f.engine.stateDir,
    profile: "fixture",
  });
  const record = s.read().records[r.exchangeId];
  await s.commit([
    {
      section: "records",
      key: record.id,
      value: {
        ...record,
        submission: "sending",
        turnId: null,
        messageId: null,
      },
    },
  ]);
  await s.close();
  await f.restart();
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(f.sent.length, 1);
  assert.equal(
    f.engine.status().receipts.find((x) => x.exchangeId === r.exchangeId)
      .delivery,
    "accepted",
  );
});
test("unknown gateway delivery without observed nonce never resends", async (t) => {
  const f = await fixture(t);
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "request",
    requestId: "unknown",
  });
  await f.restart();
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.engine.status().receipts[0].delivery, "unknown");
});
test("malformed incoming text pauses safely at last checkpoint", async (t) => {
  const f = await fixture(t);
  await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
  });
  f.page.push({
    id: "bad",
    kind: "send-message",
    requestId: "r",
    text: "x".repeat(70000),
  });
  await f.engine.tick();
  assert.equal(f.engine.status().targets[0].state, "paused");
  assert.equal(f.engine.status().targets[0].cursor, null);
});
test("intake capacity retains old checkpoint and all pending records", async (t) => {
  const f = await fixture(t);
  await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
  });
  await f.engine.close();
  const { openRelayEngine } = await import("../src/core/relay/engine.js");
  const limited = await openRelayEngine({
    stateDir: f.engine.stateDir,
    profile: "fixture",
    env: { CODEX_HOME: f.fake.home },
    gateway: { tail: async () => f.page },
    limits: { records: 1 },
  });
  t.after(() => limited.close());
  f.page.push(
    { id: "one", kind: "send-message", requestId: "r", text: "one" },
    { id: "two", kind: "send-message", requestId: "r", text: "two" },
  );
  await limited.tick();
  assert.equal(limited.status().targets[0].reason, "capacity");
  assert.equal(limited.status().targets[0].cursor, null);
  assert.equal(limited.status().receiptCount, 0);
});

test("hop-bound reply pauses visibly instead of creating a further delivery", async (t) => {
  const f = await fixture(t);
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "last hop",
    requestId: "hop",
    hop: 3,
  });
  f.page.push(
    {
      id: "user",
      kind: "user",
      clientNonce: f.sent[0].clientNonce,
      requestId: "req",
    },
    { id: "reply", kind: "send-message", requestId: "req", text: "reply" },
  );
  await f.engine.tick();
  assert.equal(f.engine.status().targets[0].reason, "hop-limit");
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    0,
  );
});

test("control request identity is independent of JSON property order", async (t) => {
  const f = await fixture(t);
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "same",
    requestId: "ordered",
  });
  await f.engine.sendToGrok({
    requestId: "ordered",
    message: "same",
    codexThreadId: "thread",
    grokTarget: "target",
  });
  assert.equal(f.sent.length, 1);
});

for (const finalStatus of ["completed", "failed", "interrupted"])
  test(`empty ${finalStatus} result returns status once`, async (t) => {
    const f = await fixture(t, { finalStatus, finalText: "" });
    await f.engine.sendToCodex({
      grokTarget: "target",
      codexThreadId: "thread",
      message: "direct",
    });
    await f.engine.tick();
    await f.engine.tick();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, new RegExp(`status ${finalStatus}`));
  });
test("real socket disconnect after submission reconciles without replay", async (t) => {
  const f = await fixture(t, { disconnect: true });
  const r = await f.engine.sendToCodex({
    grokTarget: "target",
    codexThreadId: "thread",
    message: "uncertain",
  });
  assert.equal(r.delivery, "unknown");
  await f.restart();
  await f.engine.tick();
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/start").length,
    1,
  );
  assert.equal(f.sent.length, 1);
});
test("multiple tracked routes isolate requestIds across originating threads", async (t) => {
  const f = await fixture(t);
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread-a",
    message: "a",
  });
  await f.engine.sendToGrok({
    grokTarget: "target",
    codexThreadId: "thread-b",
    message: "b",
  });
  f.page.push(
    {
      id: "ua",
      kind: "user",
      clientNonce: f.sent[0].clientNonce,
      requestId: "a",
    },
    {
      id: "ub",
      kind: "user",
      clientNonce: f.sent[1].clientNonce,
      requestId: "b",
    },
    { id: "rb", kind: "send-message", requestId: "b", text: "answer b" },
    { id: "ra", kind: "send-message", requestId: "a", text: "answer a" },
  );
  await f.engine.tick();
  const sends = f.fake.received.filter((r) => r.method === "turn/start");
  assert.equal(sends.length, 2);
  assert.ok(
    sends
      .find((r) => r.params.threadId === "thread-a")
      .params.input[0].text.includes("answer a"),
  );
  assert.ok(
    sends
      .find((r) => r.params.threadId === "thread-b")
      .params.input[0].text.includes("answer b"),
  );
});

test("stopping the sole binding closes owned observation without interrupting the turn", async (t) => {
  const f = await fixture(t, { active: true });
  const b = await f.engine.startBinding({
    grokTarget: "target",
    codexThreadId: "thread",
  });
  await f.engine.stopBinding({ bindingId: b.id });
  assert.equal(f.engine.status().generation, null);
  assert.equal(
    f.fake.received.filter((r) => r.method === "turn/interrupt").length,
    0,
  );
});

test("concurrent identical control requests claim and send exactly once", async (t) => {
  const f = await fixture(t);
  const input = {
    grokTarget: "target",
    codexThreadId: "thread",
    message: "concurrent",
    requestId: "race",
  };
  const [a, b] = await Promise.all([
    f.engine.sendToGrok(input),
    f.engine.sendToGrok({ ...input }),
  ]);
  assert.equal(a.exchangeId, b.exchangeId);
  assert.equal(f.sent.length, 1);
});
test("concurrent changed-input reuse is rejected without a second send", async (t) => {
  const f = await fixture(t);
  const input = {
    grokTarget: "target",
    codexThreadId: "thread",
    message: "original",
    requestId: "race",
  };
  const results = await Promise.allSettled([
    f.engine.sendToGrok(input),
    f.engine.sendToGrok({ ...input, message: "changed" }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /Idempotency/);
  assert.equal(f.sent.length, 1);
});

test("invalid Codex correlation is rejected before an outbound Grok submission", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.engine.sendToGrok({
      grokTarget: "target",
      codexThreadId: "thread",
      message: "bad correlation",
      correlationId: "not/a/codex/id",
    }),
  );
  assert.equal(f.sent.length, 0);
});

for (const method of ["sendToGrok", "sendToCodex"])
  test(`binding rejects conflicting explicit Grok target before ${method}`, async (t) => {
    const f = await fixture(t);
    const binding = await f.engine.startBinding({
      grokTarget: "bound-target",
      codexThreadId: "thread",
      requestId: "binding",
    });
    await assert.rejects(
      f.engine[method]({
        bindingId: binding.id,
        grokTarget: "different-target",
        message: "do not send",
        requestId: "conflicting-send",
      }),
      /Grok target.*binding/i,
    );
    assert.equal(f.sent.length, 0);
    assert.equal(
      f.fake.received.filter((x) =>
        ["turn/start", "turn/steer"].includes(x.method),
      ).length,
      0,
    );
    assert.equal(f.engine.status().receiptCount, 0);
  });
