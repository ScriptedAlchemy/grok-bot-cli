import test from "node:test";
import assert from "node:assert/strict";
import { addSkill, listSkills, removeSkill } from "../src/core/gateway.js";

const session = { gatewayUrl: "http://127.0.0.1:1340", gatewayToken: "test-token" };
const group = { id: "group-1", name: "Launch", isGroup: true, memberIds: ["bot-1"] };
const bot = { id: "bot-1", name: "Researcher", title: "", isGroup: false };
// Wire shapes from the harness: library skills are `workflow`; team, plugin, and cron entries ride along.
const librarySkill = { id: "wf-1", name: "poteto-mode", description: "Lazy senior dev", source: "workflow", body: "..." };
const pluginSkill = { id: "wf-2", name: "talk-to-grok-bot", description: "", source: "plugin", pluginId: "77" };
const automation = { id: "auto-1", name: "Daily digest", description: "", source: "automation", trigger: { schedule: "0 9 * * *" } };

function mockGateway(t, { agents = [group, bot], workflows = [librarySkill, pluginSkill, automation], imported = { id: "wf-3", name: "new-skill" }, importReply } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const method = new URL(url).pathname.split("/").pop();
    const body = JSON.parse(options.body);
    calls.push({ method, body });
    if (method === "importAgentWorkflowText" && importReply) return importReply();
    const data = {
      listAgents: { agents },
      getAgentWorkflows: workflows,
      importAgentWorkflowText: imported
        ? { workflows: [...workflows, { ...imported, description: "", source: "workflow" }], result: { imported: [imported], skipped: [] } }
        : { workflows, result: { imported: [], skipped: [{ source: "pasted skill", reason: "empty or invalid" }] } },
      deleteAgentWorkflow: workflows.filter((w) => w.id !== body.workflowId),
    }[method];
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return calls;
}

test("list uses the first bot (never a group) and strips bodies", async (t) => {
  const calls = mockGateway(t);
  const skills = await listSkills(session);
  assert.deepEqual(calls.at(-1), { method: "getAgentWorkflows", body: { id: bot.id } });
  assert.deepEqual(skills, [
    { id: "wf-1", name: "poteto-mode", description: "Lazy senior dev", source: "workflow" },
    { id: "wf-2", name: "talk-to-grok-bot", description: "", source: "plugin", pluginId: "77" },
    { id: "auto-1", name: "Daily digest", description: "", source: "automation" },
  ]);
});

test("list explains when the account has no bot to route through", async (t) => {
  mockGateway(t, { agents: [group] });
  await assert.rejects(listSkills(session), { name: "GatewayError", message: /at least one bot/ });
});

test("add imports the markdown and returns the new library record", async (t) => {
  const calls = mockGateway(t);
  const skill = await addSkill(session, "---\nname: new-skill\n---\nBody");
  assert.deepEqual(calls.find((c) => c.method === "importAgentWorkflowText").body, { id: bot.id, markdown: "---\nname: new-skill\n---\nBody" });
  assert.deepEqual(skill, { id: "wf-3", name: "new-skill", description: "", source: "workflow" });
});

test("add surfaces the gateway skip reason instead of a silent no-op", async (t) => {
  mockGateway(t, { imported: null });
  await assert.rejects(addSkill(session, "# no frontmatter"), { name: "GatewayError", message: /empty or invalid/ });
});

for (const [label, markdown, error] of [
  ["empty markdown", "  \n", /empty/],
  ["markdown Grok Bot would truncate", "x".repeat(100001), /truncates bodies over 100000/],
]) {
  test(`add rejects ${label} before touching the gateway`, async (t) => {
    const calls = mockGateway(t);
    await assert.rejects(addSkill(session, markdown), { name: "GatewayError", message: error });
    assert.equal(calls.length, 0);
  });
}

test("add says the import may have landed when the echoed list exceeds the response cap", async (t) => {
  mockGateway(t, { importReply: () => new Response("[" + "\"x\",".repeat(600000) + "\"x\"]", { status: 200 }) });
  await assert.rejects(addSkill(session, "# Skill\nbody"), { name: "GatewayError", message: /may still have landed. Run gbot skills list/ });
});

test("remove deletes a library skill by name, case-insensitively", async (t) => {
  const calls = mockGateway(t);
  const skill = await removeSkill(session, "POTETO-MODE");
  assert.deepEqual(calls.at(-1), { method: "deleteAgentWorkflow", body: { id: bot.id, workflowId: "wf-1" } });
  assert.equal(skill.id, "wf-1");
});

for (const [label, skillRef, error] of [
  ["unknown skills", "missing", /No skill "missing"/],
  ["plugin skills", "talk-to-grok-bot", /is a plugin, not a library skill/],
  ["automations", "auto-1", /is a scheduled automation/],
]) {
  test(`remove refuses ${label} without deleting`, async (t) => {
    const calls = mockGateway(t);
    await assert.rejects(removeSkill(session, skillRef), { name: "GatewayError", message: error });
    assert.ok(calls.every((c) => c.method !== "deleteAgentWorkflow"));
  });
}

test("remove refuses an ambiguous name", async (t) => {
  const calls = mockGateway(t, { workflows: [librarySkill, { ...librarySkill, id: "wf-9" }] });
  await assert.rejects(removeSkill(session, librarySkill.name), { name: "GatewayError", message: /Ambiguous/ });
  assert.ok(calls.every((c) => c.method !== "deleteAgentWorkflow"));
});
