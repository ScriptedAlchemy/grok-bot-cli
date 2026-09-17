import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { relayProfile } from "../src/core/relay/profile.js";
import { runRelayWorker } from "../src/core/relay/worker.js";
import { relayRequest } from "../src/core/relay/control.js";

const env = { CODEX_HOME: "/tmp/test-codex", GROK_BOT_TEST: "1" };
test("profile shares hosts but isolates endpoint, auth overrides and caller restrictions", () => {
  const base = relayProfile(env);
  assert.equal(
    base,
    relayProfile({
      ...env,
      AGENT_BUNDLE_PLUGIN_ROOT: "/other host",
      CODEX_THREAD_ID: "stale",
    }),
  );
  for (const extra of [
    { GROK_BOT_CODEX_THREADS: "thread-1" },
    { GROK_BOT_MAX_HOPS: "2" },
    { GROK_BOT_GATEWAY_TOKEN: "secret" },
    { GROK_BOT_GATEWAY_HEADERS: '{"x-route":"secret"}' },
    { CODEX_APP_SERVER_SOCK: "/other.sock" },
    { GROK_BOT_TEST: "0" },
    { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
    { DISPLAY: ":0" },
  ])
    assert.notEqual(base, relayProfile({ ...env, ...extra }));
  assert.ok(
    !relayProfile({ ...env, GROK_BOT_GATEWAY_TOKEN: "secret" }).includes(
      "secret",
    ),
  );
});
test("only socket owner opens engine, profile mismatch refuses, stop closes owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-worker-"));
  const profile = relayProfile(env);
  let opened = 0,
    closed = 0;
  const openEngine = async () => {
    opened++;
    return {
      status: () => ({ state: "running", bindings: [], receipts: [] }),
      tick: async () => {},
      close: async () => {
        closed++;
      },
    };
  };
  const worker = await runRelayWorker({ stateDir, profile, env, openEngine });
  try {
    assert.equal(
      (await relayRequest({ stateDir, profile, env }, "hello", {})).worker
        .state,
      "running",
    );
    await assert.rejects(
      runRelayWorker({ stateDir, profile, env, openEngine }),
      /owner|running|locked/i,
    );
    assert.equal(opened, 1);
    await assert.rejects(
      relayRequest({ stateDir, profile: "other", env }, "hello", {}),
      /profile/i,
    );
    assert.equal(
      (await relayRequest({ stateDir, profile, env }, "status", {})).worker
        .supervised,
      false,
    );
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});
test("worker rejects symlink lock before opening engine", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "relay-worker-"));
  await symlink("/tmp/missing", join(stateDir, "worker.lock"));
  try {
    await assert.rejects(
      runRelayWorker({
        stateDir,
        profile: relayProfile(env),
        env,
        openEngine: () => {
          throw Error("engine must not open");
        },
      }),
      /symlink|regular/i,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("live control listener without metadata is never unlinked or opened as another engine", async () => {
  const { createServer } = await import("node:net");
  const { lstat } = await import("node:fs/promises");
  const { relayLocation } = await import("../src/core/relay/profile.js");
  const stateDir = await mkdtemp("/tmp/relay-owner-");
  const location = relayLocation({ stateDir, env });
  const server = createServer((s) => s.end());
  await new Promise((r) => server.listen(location.socketPath, r));
  try {
    await assert.rejects(
      runRelayWorker({
        ...location,
        openEngine: () => {
          throw Error("must not open");
        },
      }),
      /listener already running/,
    );
    assert.equal((await lstat(location.socketPath)).isSocket(), true);
  } finally {
    await new Promise((r) => server.close(r));
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("ownership keeps one lock inode across clean restarts and protects SQLite sidecars", async () => {
  const { lstat } = await import("node:fs/promises");
  const stateDir = await mkdtemp("/tmp/relay-inode-");
  const profile = relayProfile(env);
  const openEngine = async () => ({
    status: () => ({}),
    tick: async () => {},
    close: async () => {},
  });
  let worker = await runRelayWorker({ stateDir, profile, env, openEngine });
  try {
    const first = await lstat(join(stateDir, "worker.lock"));
    await worker.close();
    assert.equal((await lstat(join(stateDir, "worker.lock"))).ino, first.ino);
    worker = await runRelayWorker({ stateDir, profile, env, openEngine });
    assert.equal((await lstat(join(stateDir, "worker.lock"))).ino, first.ino);
    await worker.close();
    await symlink("/tmp/foreign-owner", join(stateDir, "worker.lock-journal"));
    await assert.rejects(
      runRelayWorker({ stateDir, profile, env, openEngine }),
      /symlink|regular/,
    );
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("private control protocol preserves UTF-8 text across socket chunks", async () => {
  const { connect } = await import("node:net");
  const stateDir = await mkdtemp("/tmp/relay-utf8-");
  const profile = relayProfile(env);
  const worker = await runRelayWorker({
    stateDir,
    profile,
    env,
    openEngine: async () => ({
      tick: async () => {},
      close: async () => {},
      sendToGrok: async (input) => ({ text: input.message }),
    }),
  });
  try {
    const text = "hello 🛰️ 世界";
    const request = Buffer.from(
      JSON.stringify({
        version: 1,
        profile,
        requestId: "split-utf8",
        method: "sendToGrok",
        input: { message: text },
      }) + "\n",
    );
    const split = request.indexOf(Buffer.from("🛰")) + 1;
    const out = await new Promise((resolve, reject) => {
      const socket = connect(worker.location.socketPath);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (c) => (buffer += c));
      socket.on("end", () => resolve(JSON.parse(buffer)));
      socket.on("connect", () => {
        socket.write(request.subarray(0, split));
        setTimeout(() => socket.end(request.subarray(split)), 20);
      });
    });
    assert.equal(out.result.text, text);
  } finally {
    await worker.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test("short socket fallback refuses a symlinked parent directory", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { claimRelayOwner } = await import("../src/core/relay/ownership.js");
  const root = await mkdtemp("/tmp/relay-parent-");
  await mkdir(join(root, "actual"));
  await symlink(join(root, "actual"), join(root, "alias"));
  try {
    await assert.rejects(
      claimRelayOwner({
        stateDir: join(root, "state"),
        socketDir: join(root, "alias", "child"),
        socketPath: join(root, "alias", "child", "control.sock"),
      }),
      /symlink|owned/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
