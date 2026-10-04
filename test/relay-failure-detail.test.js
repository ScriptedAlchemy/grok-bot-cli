import assert from "node:assert/strict";
import test from "node:test";
import { createCompletion } from "../src/core/relay/completion.js";
import { errorDetail } from "../src/core/relay/detail.js";
import { describeDelivery } from "../src/core/format.js";
import { receipt } from "../src/core/relay/records.js";
import { renderEnvScript } from "../src/core/desktop-shim.js";

test("errorDetail is one bounded control-free line", () => {
  assert.equal(errorDetail(new Error("a\nb\u0000  c")), "a b c");
  assert.equal(errorDetail("x".repeat(3000)).length, 1024);
  assert.equal(errorDetail(undefined), undefined);
  assert.equal(errorDetail({}), undefined);
});

test("a failed turn's Codex error reaches the Grok return text and the record", async () => {
  const data = {
    records: {
      r1: {
        id: "r1", kind: "codex", submission: "accepted", turnId: "turn1", targetId: "t", threadId: "th",
        expectedCwd: "/x", execution: "pending", reason: null, returnToGrok: true, sourceIds: [], hop: 0, maxHops: 4,
        correlationId: "c", busyPolicy: "steer", bindingId: null, text: "hi", clientId: "k", submission: "accepted",
      },
    },
  };
  const created = [];
  const complete = createCompletion({
    env: {},
    state: {
      read: () => data,
      commit: async (changes) => {
        for (const c of changes) if (c.section === "records" || c.name === "records") created.push(c.value ?? c.record ?? c);
      },
    },
    codex: {
      wait: async () => ({
        execution: { state: "failed", error: "Fatal error: Too many open files (os error 24)" },
        reply: { text: "", truncated: false, items: [] },
      }),
    },
    update: async () => {},
    newRecord: (kind, id, r, text) => ({ id, kind, text }),
    runnable: () => true,
  });
  await complete();
  const texts = JSON.stringify(created);
  assert.match(texts, /Codex turn failed with no final text: Fatal error: Too many open files/);
  assert.match(texts, /"detail":"Fatal error: Too many open files/);
});

test("receipts carry the rejection detail", () => {
  const base = {
    id: "e", kind: "codex", targetId: "t", clientId: "c", correlationId: "x", requestId: null, sourceIds: [], returnId: null,
    hop: 0, maxHops: 4, submission: "rejected", threadId: "th", bindingId: null, execution: "pending", reason: "thread-error",
    detail: "Codex thread th is in systemError state",
  };
  assert.equal(receipt(base).detail, "Codex thread th is in systemError state");
  assert.equal("detail" in receipt({ ...base, detail: undefined }), false);
});

test("describeDelivery explains rejections instead of repeating 'terminal answer returns'", () => {
  const text = describeDelivery(
    { delivery: "rejected", reason: "thread-error", detail: "Codex thread th is in systemError state" },
    { managed: true },
  );
  assert.match(text, /^Delivery rejected \(thread-error\): Codex thread th is in systemError state/);
  assert.match(text, /gbot codex status/);
  assert.doesNotMatch(text, /terminal answer returns/);
  assert.match(describeDelivery({ delivery: "accepted" }, { managed: true }), /Delivery accepted; terminal answer returns to Grok/);
  assert.match(describeDelivery({ delivery: "rejected", reason: "busy" }), /--when-busy steer/);
});

test("daemon login script raises the open-file limit before starting the daemon", () => {
  const script = renderEnvScript({ codexHome: "/c", envLogPath: "/l", realPath: "/r", wrapperPath: "/w" });
  const limit = script.indexOf("ulimit -n 65536");
  const start = script.indexOf('"$REAL" app-server daemon start');
  assert.ok(limit > 0 && start > limit);
});
