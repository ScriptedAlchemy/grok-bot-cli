import { mkdtempSync, rmSync } from "node:fs";
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
