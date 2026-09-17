import assert from "node:assert/strict";
import test from "node:test";
import { listGrokApprovals, respondGrokApproval } from "../src/core/gateway.js";

test("Grok responses require a current exact card and only grant once or reject", async t => {
  const original = globalThis.fetch;
  const testEnv = process.env.GROK_BOT_TEST;
  process.env.GROK_BOT_TEST = '1';
  t.after(() => {
    globalThis.fetch = original;
    if (testEnv === undefined) delete process.env.GROK_BOT_TEST;
    else process.env.GROK_BOT_TEST = testEnv;
  });
  const calls = [];
  const approval = { requestId: "ask", status: "pending", command: "npm publish" };
  const entries = [{ id: "card", kind: "send-message", message: { type: "auto-review-approval", approval } }];
  globalThis.fetch = async (url, options) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    const result = method === "listAgents" ? { agents: [{ id: "bot", name: "Router" }] }
      : method === "getAgentTranscriptTail" ? { entries } : {};
    return new Response(JSON.stringify(result));
  };
  const session = { gatewayUrl: "http://127.0.0.1:1", gatewayToken: "fixture" };
  assert.equal((await listGrokApprovals(session, "bot")).approvals[0].requestId, "ask");
  for (const patch of [{ requestId: "foreign" }, { entryId: "foreign" }, { decision: "always" }]) {
    await assert.rejects(respondGrokApproval(session, "bot", { entryId: "card", requestId: "ask", decision: "accept", ...patch }));
  }
  assert.equal(calls.filter(c => c.method.startsWith("resolve")).length, 0);
  await respondGrokApproval(session, "bot", { entryId: "card", requestId: "ask", decision: "accept" });
  assert.deepEqual(calls.at(-1), { method: "resolveAutoReviewApproval", body: {
    agentId: "bot", entryId: "card", requestId: "ask", resolution: "approved",
  } });
  approval.status = "expired";
  await assert.rejects(respondGrokApproval(session, "bot", { entryId: "card", requestId: "ask", decision: "accept" }));
  entries[0].message = { type: "local-tool-permission", ask: { requestId: "local", status: "pending", action: "run-command", target: "rm ./output.txt", machineId: "ubuntu" } };
  assert.deepEqual((await listGrokApprovals(session, "bot")).approvals[0], {
    entryId: "card", requestId: "local", type: "local-tool-permission", action: "run-command",
    target: "rm ./output.txt", machineId: "ubuntu", truncated: false,
  });
  await respondGrokApproval(session, "bot", { entryId: "card", requestId: "local", decision: "decline" });
  assert.equal(calls.at(-1).method, "resolveLocalToolPermission");
  assert.equal(calls.at(-1).body.resolution, "deny");
  await respondGrokApproval(session, "bot", { entryId: "card", requestId: "local", decision: "accept" });
  assert.equal(calls.at(-1).body.resolution, "allow-once");
  entries[0].message.ask.target = "x".repeat(3000);
  assert.equal((await listGrokApprovals(session, "bot")).approvals[0].truncated, true);
  const before = calls.filter(c => c.method.startsWith("resolve")).length;
  await assert.rejects(respondGrokApproval(session, "bot", { entryId: "card", requestId: "local", decision: "accept" }), /truncated/);
  assert.equal(calls.filter(c => c.method.startsWith("resolve")).length, before);
});
