import test from "node:test";
import assert from "node:assert/strict";

import { GATEWAY_MAX_RESPONSE_BYTES, getTranscriptTail, sendPrompt } from "../src/core/gateway.js";

const session = { gatewayUrl: "https://box.cursor.sh", gatewayToken: "t" };
const roster = { agents: [{ id: "bot-1", name: "General" }] };

function mockGateway(t, send) {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    return send();
  });
}

test("sendPrompt accepts only a confirmed messageId receipt", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ messageId: "m-1" }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "accepted");
  assert.equal(out.messageId, "m-1");
});

test("sendPrompt without a receipt is unknown, not accepted", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const out = await sendPrompt(session, "General", "hi");
  assert.equal(out.delivery, "unknown");
  assert.equal(out.messageId, undefined);
});

test("sendPrompt rejects on a 4xx and preserves the target id", async (t) => {
  mockGateway(t, () => new Response(JSON.stringify({ message: "nope" }), { status: 400 }));
  await assert.rejects(sendPrompt(session, "General", "hi"), (e) => {
    assert.equal(e.delivery, "rejected");
    assert.equal(e.targetId, "bot-1");
    return true;
  });
});

test("sendPrompt marks transport loss unknown with a no-retry hint", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    throw new TypeError("fetch failed");
  });
  await assert.rejects(sendPrompt(session, "General", "hi"), (e) => {
    assert.equal(e.delivery, "unknown");
    assert.match(e.message, /delivery unknown; check the thread before resending/);
    return true;
  });
});

test("oversized gateway responses abort mid-stream instead of buffering", async (t) => {
  mockGateway(t, () => new Response("x".repeat(GATEWAY_MAX_RESPONSE_BYTES + 8), { status: 200 }));
  await assert.rejects(sendPrompt(session, "General", "hi"), /too large/);
});

test("getTranscriptTail clamps the limit to 1-200 like the CLI and tool", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/api/listAgents")) return new Response(JSON.stringify(roster), { status: 200 });
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ entries: [] }), { status: 200 });
  });
  await getTranscriptTail(session, "General", 99999);
  assert.equal(seen[0].limit, 200);
  await getTranscriptTail(session, "General", -3);
  assert.equal(seen[1].limit, 1);
});
