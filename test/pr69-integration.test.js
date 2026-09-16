import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { sendToCodexThread } from "../src/core/codex-bridge.js";
import { pageEntries } from "../src/core/relay/records.js";
import { transcriptEntries } from "../src/core/transcript.js";
import { openBackend } from "../src/core/commands.js";

const envelope = { messageId: "caller-message", correlationId: "caller-correlation", hop: 0, header: false };
test("PR69 keeps conversation imports and persistent session APIs usable", async () => {
  const conversation = await import("../src/core/codex/conversation.js");
  const bridge = await import("../src/core/codex-bridge.js");
  assert.equal(typeof conversation.openCodexConversation, "function");
  assert.equal(typeof bridge.openCodexSession, "function");
  bridge.assertThreadAllowed("thread-1", {});
  assert.equal(bridge.experimentalEnabled({ GROK_BOT_CODEX_EXPERIMENTAL: "1" }), true);
});
for (const mode of ["usage", "hop-limit", "cancelled", "thread-mismatch", "cwd-mismatch", "cwd-error", "steer-ack"]) {
  test(`PR69 flat error retains caller identity: ${mode}`, async () => {
    const controller = new AbortController();
    if (mode === "cancelled") controller.abort();
    const calls = [];
    const session = { client: { async request(method) {
      calls.push(method);
      if (method === "thread/resume") return { thread: { id: mode === "thread-mismatch" ? "other" : "thread-1", status: { type: "idle" } }, cwd: mode === "cwd-error" ? "/nonexistent-gbot-cwd" : process.cwd() };
      if (method === "turn/steer") return { turnId: "wrong" };
      throw new Error("Unexpected mutation");
    } } };
    const result = await sendToCodexThread("thread-1", mode === "usage" ? "" : "hello", {
      env: {}, session, envelope: { ...envelope, hop: mode === "hop-limit" ? 99 : 0 }, signal: controller.signal,
      ...(mode.startsWith("cwd") ? { expectedCwd: tmpdir() } : {}),
      ...(mode === "steer-ack" ? { whenBusy: "steer", expectedTurnId: "turn-1" } : {}),
    });
    assert.equal(result.messageId, envelope.messageId);
    assert.equal(result.correlationId, envelope.correlationId);
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.hop, mode === "hop-limit" ? 99 : 0);
    assert.equal(result.delivery, mode === "steer-ack" ? "unknown" : "rejected");
    assert.equal(result.envelope, undefined);
    assert.equal(calls.includes("turn/start"), false);
  });
}

test("PR69 backend forwards durable nonce and reply constraints", async (t) => {
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GROK_BOT_TEST: "1", GROK_BOT_GATEWAY_URL: "http://127.0.0.1:1340", GROK_BOT_GATEWAY_TOKEN: "fixture" });
  t.after(() => { process.env = oldEnv; });
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/listAgents")) return Response.json({ agents: [{ id: "bot-1", name: "Bot" }] });
    assert.ok(url.endsWith("/sendPrompt"));
    sent.push(JSON.parse(options.body));
    return Response.json({ id: "message-1" });
  });
  const backend = await openBackend({ gateway: true });
  await backend.send("bot-1", "hello", { clientNonce: "durable-nonce", replyToId: "parent-message" });
  assert.deepEqual(sent, [{ agentId: "bot-1", prompt: "hello", clientNonce: "durable-nonce", replyToId: "parent-message" }]);
});

const entries = [{ id: "source-1", kind: "user-message" }];
for (const payload of [entries, { messages: entries }, { items: entries }, { transcript: entries }, { transcript: { messages: entries } }]) {
  test(`PR69 unsupported transcript container is rejected: ${JSON.stringify(payload)}`, () => {
    assert.throws(() => pageEntries(payload), /Invalid transcript coverage envelope/);
  });
}
test("PR69 canonical transcript coverage and extraction agree", () => {
  for (const payload of [{ entries }, { transcript: { entries } }]) {
    assert.deepEqual(pageEntries(payload), transcriptEntries(payload.transcript ?? payload));
    assert.deepEqual(pageEntries(payload), entries);
  }
  assert.deepEqual(pageEntries({ entries: [] }), []);
});
