import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const load = () => import("../src/core/relay/state.js");
const target = {
  id: "opaque / target",
  cursor: null,
  baseline: true,
  state: "running",
  reason: null,
  nextPoll: 0,
  failures: 0,
};
test("state commits atomically, reopens without replay, and skips unchanged patches", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    s = await openRelayState({ dir, profile: "test" });
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    const before = await s.inspect();
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    assert.equal((await s.inspect()).headRevision, before.headRevision);
    await s.close();
    s = await openRelayState({ dir, profile: "test" });
    assert.deepEqual(s.read().targets[target.id], target);
    // Windows reports 0o666 regardless of chmod; Unix mode bits are not stored.
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "relay.sqlite"))).mode & 0o777, 0o600);
    }
    await s.close();
    s = null;
    await assert.rejects(openRelayState({ dir, profile: "other" }), /profile/);
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("state refuses symlink database, corruption and capacity without resetting", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    const file = join(dir, "relay.sqlite");
    await symlink("/tmp", file);
    await assert.rejects(
      openRelayState({ dir, profile: "test" }),
      /regular|symlink/,
    );
    await rm(file);
    await writeFile(file, "broken");
    await assert.rejects(openRelayState({ dir, profile: "test" }));
    assert.equal((await stat(file)).size, 6);
    await rm(file);
    s = await openRelayState({ dir, profile: "test", limits: { targets: 1 } });
    await s.commit([{ section: "targets", key: target.id, value: target }]);
    await assert.rejects(
      s.commit([
        {
          section: "targets",
          key: "second",
          value: { ...target, id: "second" },
        },
      ]),
      /capacity/,
    );
    assert.equal(Object.keys(s.read().targets).length, 1);
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("journal compaction stays bounded and unsupported versions fail closed", async () => {
  const { openRelayState } = await load();
  const dir = await mkdtemp(join(tmpdir(), "relay-state-"));
  let s;
  try {
    s = await openRelayState({ dir, profile: "test" });
    for (let i = 0; i < 20; i++)
      await s.commit([
        {
          section: "targets",
          key: target.id,
          value: { ...target, nextPoll: i },
        },
      ]);
    assert.ok((await s.inspect()).records < 8);
    await s.close();
    s = null;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "relay.sqlite"));
    db.exec("UPDATE agent_state_meta SET schema_version = 999");
    db.close();
    await assert.rejects(
      openRelayState({ dir, profile: "test" }),
      /version|migration|schema/,
    );
  } finally {
    await s?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
