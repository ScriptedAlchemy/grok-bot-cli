import test from "node:test";
import assert from "node:assert/strict";
import { createGroup, updateAgent } from "../src/core/gateway.js";

const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "test-token" };
const bot = { id: "bot-1", name: "Reader", title: "", description: "old", isGroup: false };

function mockGateway(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    calls.push({ method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(method === "listAgents" ? { agents: [bot] } : {}), { status: 200 });
  });
  return calls;
}

test("update lists the changed profile fields in editedFields so Grok Bot saves them", async (t) => {
  const calls = mockGateway(t);
  await updateAgent(session, "Reader", { description: "new", avatarColor: "orange" });
  const update = calls.find((c) => c.method === "updateAgent");
  assert.deepEqual(update.body.editedFields, ["description", "avatarColor"]);
  assert.equal(update.body.profile.description, "new");
  assert.equal(update.body.profile.name, "Reader");
});

test("update with only notify skips the profile call", async (t) => {
  const calls = mockGateway(t);
  await updateAgent(session, "Reader", { notifyOnAgentUpdates: false });
  assert.ok(!calls.some((c) => c.method === "updateAgent"));
  assert.ok(calls.some((c) => c.method === "setAgentNotifyOnUpdates"));
});

test("update saves a cloud bot's edited fields on the backend first, then marks them server-held on the box", async (t) => {
  const env = { CURSOR_ACCESS_TOKEN: "test-access", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    const data = {
      EnsureSandBox: { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "gw" },
      ListGrokBotAgents: { agents: [{ id: "555", agentId: bot.id, harness: "temporal", viewerIsOwner: true }] },
      UpdateGrokBotAgent: { agent: { id: "555", updatedAtMs: "1700000000000" } },
      listAgents: { agents: [bot] },
    }[method] ?? {};
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const { connectGateway } = await import("../src/core/gateway.js");
  const live = await connectGateway({ appSessionOptions: { home: "/nonexistent-home" } });
  await updateAgent(live, "Reader", { description: "new" });

  const order = calls.map((c) => c.method).filter((m) => m === "UpdateGrokBotAgent" || m === "updateAgent");
  assert.deepEqual(order, ["UpdateGrokBotAgent", "updateAgent"]);
  assert.deepEqual(calls.find((c) => c.method === "UpdateGrokBotAgent").body, { id: "555", description: "new", partialUpdate: true });
  const box = calls.find((c) => c.method === "updateAgent").body;
  assert.deepEqual(box.serverHeldFields, ["description"]);
  assert.equal(box.serverSavedAtMs, 1700000000000);
});

test("create group goes through the backend CreateGrokBotRoom, then reads the mirrored group from the box", async (t) => {
  const env = { CURSOR_ACCESS_TOKEN: "test-access", CURSOR_API_BASE_URL: "http://127.0.0.1:1341" };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const calls = [];
  let room = null;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body, headers: options.headers });
    if (method === "CreateGrokBotRoom") room = { id: body.agentId, name: body.name, isGroup: true, memberIds: body.memberAgentIds };
    const data = {
      EnsureSandBox: { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "gw", gatewayPortToken: "pt" },
      CreateGrokBotRoom: { agent: { agentId: body.agentId } },
      ListGrokBotAgents: { agents: [] },
      listAgents: { agents: room ? [bot, room] : [bot] },
    }[method] ?? {};
    return new Response(JSON.stringify(data), { status: 200 });
  });
  const { connectGateway } = await import("../src/core/gateway.js");
  const live = await connectGateway({ appSessionOptions: { home: "/nonexistent-home" } });
  const rec = await createGroup(live, { name: "Team", description: "d", memberIds: ["Reader"] });

  const create = calls.find((c) => c.method === "CreateGrokBotRoom");
  assert.equal(create.body.name, "Team");
  assert.equal(create.body.description, "d");
  assert.deepEqual(create.body.memberAgentIds, ["bot-1"]);
  assert.deepEqual(create.body.humanMemberUserIds, []);
  assert.match(create.body.agentId, /^[0-9a-f-]{36}$/);
  assert.equal(rec.id, create.body.agentId);
  assert.ok(!calls.some((c) => c.method === "createGroup"), "no gateway createGroup when the backend created it");
});
