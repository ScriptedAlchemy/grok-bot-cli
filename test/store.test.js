import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  addGroupMember,
  createAgent,
  createGroup,
  deleteAgent,
  listRecords,
  removeGroupMember,
  setGroupMembers,
  updateAgent,
} from "../src/store.js";

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "gbot-"));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

test("create list delete bots", async () => {
  await withRoot((root) => {
    const a = createAgent(root, { name: "Oncall", description: "pages" });
    assert.equal(a.name, "Oncall");
    assert.equal(listRecords(root).length, 1);
    deleteAgent(root, "Oncall");
    assert.equal(listRecords(root).length, 0);
  });
});

test("group add remove set", async () => {
  await withRoot((root) => {
    createAgent(root, { name: "Alpha" });
    createAgent(root, { name: "Beta" });
    createAgent(root, { name: "Gamma" });
    const g = createGroup(root, { name: "Launch", memberIds: ["Alpha", "Beta"] });
    assert.equal(g.isGroup, true);
    assert.equal(g.memberIds.length, 2);
    assert.equal(addGroupMember(root, "Launch", "Gamma").memberIds.length, 3);
    assert.equal(removeGroupMember(root, "Launch", "Beta").memberIds.length, 2);
    assert.equal(setGroupMembers(root, "Launch", ["Alpha"]).memberIds.length, 1);
  });
});

test("rejects nested and empty groups", async () => {
  await withRoot((root) => {
    createAgent(root, { name: "Alpha" });
    createGroup(root, { name: "Launch", memberIds: ["Alpha"] });
    assert.throws(() => createGroup(root, { name: "Nope", memberIds: [] }), /at least one/);
    assert.throws(() => addGroupMember(root, "Launch", "Launch"), /Nested groups/);
  });
});

test("update merges profile, clears title, changes description, toggles settings, rejects blank name", async () => {
  await withRoot((root) => {
    const a = createAgent(root, {
      name: "Oncall",
      description: "pages",
      title: "pager",
      avatarShape: "blob",
      avatarColor: "red",
    });
    assert.equal(a.notifyOnAgentUpdates, true);
    assert.equal(a.hiddenFromSidebar, false);
    assert.equal(a.avatarShape, "blob");
    assert.equal(a.avatarColor, "red");

    const merged = updateAgent(root, a.id, { description: "night pages" });
    assert.equal(merged.name, "Oncall");
    assert.equal(merged.description, "night pages");
    assert.equal(merged.title, "pager");
    assert.equal(merged.avatarShape, "blob");
    assert.equal(merged.avatarColor, "red");

    const cleared = updateAgent(root, a.id, { title: "" });
    assert.equal(cleared.title, "");
    assert.equal(cleared.description, "night pages");

    const renamed = updateAgent(root, a.id, { name: "Pagerduty" });
    assert.equal(renamed.name, "Pagerduty");
    assert.equal(renamed.description, "night pages");

    const notifyOff = updateAgent(root, a.id, { notifyOnAgentUpdates: false });
    assert.equal(notifyOff.notifyOnAgentUpdates, false);
    assert.equal(notifyOff.hiddenFromSidebar, false);

    const hidden = updateAgent(root, a.id, { hiddenFromSidebar: true });
    assert.equal(hidden.hiddenFromSidebar, true);
    assert.equal(hidden.notifyOnAgentUpdates, false);

    const listed = listRecords(root)[0];
    assert.equal(listed.avatarShape, "blob");
    assert.equal(listed.notifyOnAgentUpdates, false);
    assert.equal(listed.hiddenFromSidebar, true);

    assert.throws(() => updateAgent(root, a.id, { name: "   " }), /blank/);
    assert.throws(() => updateAgent(root, a.id, { avatarShape: "triangle" }), /avatar shape/);
  });
});

test("update settings merge preserves extra keys", async () => {
  await withRoot((root) => {
    const a = createAgent(root, { name: "Oncall" });
    const settingsPath = join(a.path, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ notifyOnAgentUpdates: true, prLinkStyle: "short" }, null, 2) + "\n");
    updateAgent(root, a.id, { hiddenFromSidebar: true });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(raw.notifyOnAgentUpdates, true);
    assert.equal(raw.hiddenFromSidebar, true);
    assert.equal(raw.prLinkStyle, "short");
  });
});
