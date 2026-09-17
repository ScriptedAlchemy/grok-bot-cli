import test from "node:test";
import assert from "node:assert/strict";
import { addAgentSkill, listAgentSkills, removeAgentSkill } from "../src/core/gateway.js";

const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "test-token" };
const bot = { id: "bot-1", name: "Researcher", title: "", isGroup: false };
const other = { id: "bot-2", name: "Writer", title: "", isGroup: false };
const group = { id: "group-1", name: "Launch", isGroup: true, memberIds: [bot.id] };
const userSkill = { id: "wf-1", name: "poteto-mode", description: "Lazy senior dev", source: "user", body: "..." };
const pluginSkill = { id: "wf-2", name: "talk-to-grok-bot", description: "", source: "plugin", pluginId: "77" };

function mockGateway(t, { workflows = [userSkill, pluginSkill], imported = { id: "wf-3", name: "new-skill" } } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    const data = {
      listAgents: { agents: [bot, other, group] },
      getAgentWorkflows: workflows,
      importAgentWorkflowText: imported
        ? { workflows: [...workflows, { ...imported, description: "", source: "user" }], result: { imported: [imported], skipped: [] } }
        : { workflows, result: { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] } },
      deleteAgentWorkflow: workflows.filter((w) => w.id !== body.workflowId),
    }[method];
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return calls;
}

test("list resolves the bot by name and strips skill bodies", async (t) => {
  const calls = mockGateway(t);
  const skills = await listAgentSkills(session, "researcher");
  assert.deepEqual(calls.at(-1), { method: "getAgentWorkflows", body: { id: bot.id } });
  assert.deepEqual(skills, [
    { id: "wf-1", name: "poteto-mode", description: "Lazy senior dev", source: "user" },
    { id: "wf-2", name: "talk-to-grok-bot", description: "", source: "plugin", pluginId: "77" },
  ]);
});

test("add imports markdown for exactly one bot id", async (t) => {
  const calls = mockGateway(t);
  const { bot: rec, skill } = await addAgentSkill(session, bot.name, "---\nname: new-skill\n---\nBody", "fallback");
  const call = calls.find((c) => c.method === "importAgentWorkflowText");
  assert.deepEqual(call.body, { id: bot.id, markdown: "---\nname: new-skill\n---\nBody", name: "fallback" });
  assert.equal(rec.id, bot.id);
  assert.deepEqual(skill, { id: "wf-3", name: "new-skill", description: "", source: "user" });
  assert.ok(calls.every((c) => c.body.id === undefined || c.body.id === bot.id));
});

test("add surfaces the gateway skip reason instead of a silent no-op", async (t) => {
  mockGateway(t, { imported: null });
  await assert.rejects(addAgentSkill(session, bot.id, "# no frontmatter"), { name: "GatewayError", message: /empty or invalid/ });
});

test("add rejects empty markdown before touching the gateway", async (t) => {
  const calls = mockGateway(t);
  await assert.rejects(addAgentSkill(session, bot.id, "  \n"), { name: "GatewayError", message: /empty/ });
  assert.equal(calls.length, 0);
});

test("skills refuse groups", async (t) => {
  const calls = mockGateway(t);
  await assert.rejects(listAgentSkills(session, group.name), { name: "GatewayError", message: /is a group/ });
  await assert.rejects(addAgentSkill(session, group.id, "x"), { name: "GatewayError", message: /is a group/ });
  assert.ok(calls.every((c) => c.method === "listAgents"));
});

test("remove deletes a user skill by name and returns it", async (t) => {
  const calls = mockGateway(t);
  const { skill } = await removeAgentSkill(session, bot.id, "POTETO-MODE");
  assert.deepEqual(calls.at(-1), { method: "deleteAgentWorkflow", body: { id: bot.id, workflowId: "wf-1" } });
  assert.equal(skill.id, "wf-1");
});

for (const [label, skillRef, error] of [
  ["unknown skills", "missing", /No skill "missing"/],
  ["plugin skills", "talk-to-grok-bot", /is a plugin skill/],
]) {
  test(`remove refuses ${label} without deleting`, async (t) => {
    const calls = mockGateway(t);
    await assert.rejects(removeAgentSkill(session, bot.id, skillRef), { name: "GatewayError", message: error });
    assert.ok(calls.every((c) => c.method !== "deleteAgentWorkflow"));
  });
}

test("remove refuses an ambiguous name", async (t) => {
  const calls = mockGateway(t, { workflows: [userSkill, { ...userSkill, id: "wf-9" }] });
  await assert.rejects(removeAgentSkill(session, bot.id, userSkill.name), { name: "GatewayError", message: /Ambiguous/ });
  assert.ok(calls.every((c) => c.method !== "deleteAgentWorkflow"));
});
