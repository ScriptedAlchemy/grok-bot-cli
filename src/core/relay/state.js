import { lstat, mkdir, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineState } from "@agent-bundle/runtime/state";

export const relayId = z.string().min(1).max(512);
const text = z
  .string()
  .refine((s) => Buffer.byteLength(s) <= 65536, "text exceeds 64 KiB");
const reason = z.string().max(1024).nullable();
const targetSchema = z.strictObject({
  id: relayId,
  cursor: relayId.nullable(),
  observedCursor: relayId.nullable().optional(),
  baseline: z.literal(true),
  state: z.enum(["running", "paused", "backoff"]),
  reason,
  nextPoll: z.number().nonnegative(),
  failures: z.number().int().nonnegative(),
});
const bindingSchema = z.strictObject({
  id: relayId,
  targetId: relayId,
  threadId: relayId,
  expectedCwd: z.string().max(4096),
  busyPolicy: z.enum(["steer", "reject"]),
  state: z.enum(["running", "stopped"]),
  createdAt: z.number(),
  createdCursor: relayId.nullable(),
  fingerprint: z.string(),
});
const recordSchema = z.strictObject({
  id: relayId,
  kind: z.enum(["grok-request", "grok-return", "codex"]),
  targetId: relayId,
  threadId: relayId,
  expectedCwd: z.string().max(4096),
  busyPolicy: z.enum(["steer", "reject"]),
  bindingId: relayId.nullable(),
  text,
  sourceIds: z.array(relayId).max(200),
  parentId: relayId.nullable(),
  returnToGrok: z.boolean(),
  clientId: relayId,
  correlationId: relayId,
  hop: z.number().int().nonnegative(),
  maxHops: z.number().int().positive(),
  submission: z.enum([
    "prepared",
    "sending",
    "accepted",
    "rejected",
    "unknown",
  ]),
  execution: z.enum([
    "pending",
    "completed",
    "failed",
    "interrupted",
    "needs-input",
    "paused",
  ]),
  reason,
  turnId: relayId.nullable(),
  requestId: relayId.nullable(),
  messageId: relayId.nullable(),
  returnId: relayId.nullable(),
  createdAt: z.number(),
  fingerprint: z.string(),
});
const sections = {
  targets: targetSchema,
  bindings: bindingSchema,
  records: recordSchema,
};
const operation = z.discriminatedUnion(
  "section",
  Object.entries(sections).map(([section, schema]) =>
    z.strictObject({
      section: z.literal(section),
      key: relayId,
      value: schema,
    }),
  ),
);
const DEFAULTS = {
  targets: 100,
  bindings: 100,
  records: 1000,
  stateBytes: 8 * 1024 * 1024,
  diskBytes: 64 * 1024 * 1024,
};

/** Check before SQLite opens any database, WAL, SHM or worker control path. */
export async function protectRelayDirectory(
  dir,
  maxBytes = DEFAULTS.diskBytes,
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const root = await lstat(dir);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (process.getuid && root.uid !== process.getuid())
  )
    throw new Error("Relay directory must be owned and not a symlink");
  await chmod(dir, 0o700);
  let totalBytes = 0;
  for (const name of [
    "relay.sqlite",
    "relay.sqlite-wal",
    "relay.sqlite-shm",
    "worker.lock",
  ]) {
    const path = join(dir, name);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Relay storage must be an owned regular file, never a symlink",
      );
    totalBytes += info.size;
    if (totalBytes > maxBytes)
      throw new Error("Relay storage capacity exceeded");
    await chmod(path, 0o600);
  }
}

/** The worker owns exclusivity; this wrapper serializes only durable mutations, never network waits. */
export async function openRelayState({ dir, profile, limits: overrides = {} }) {
  const limits = { ...DEFAULTS, ...overrides };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Invalid relay capacity");
  relayId.parse(profile);
  dir = resolve(dir);
  await protectRelayDirectory(dir, limits.diskBytes);
  const schema = z
    .strictObject({
      version: z.literal(1),
      profile: relayId,
      ...Object.fromEntries(
        Object.entries(sections).map(([name, s]) => [
          name,
          z.record(relayId, s),
        ]),
      ),
    })
    .superRefine((state, ctx) => {
      for (const section of Object.keys(sections)) {
        if (Object.keys(state[section]).length > limits[section])
          ctx.addIssue({ code: "custom", message: "Relay capacity exceeded" });
        for (const [key, value] of Object.entries(state[section]))
          if (key !== value.id)
            ctx.addIssue({ code: "custom", message: "Relay key mismatch" });
      }
    });
  const definition = defineState({
    id: "grok-codex-relay",
    version: 1,
    lifetime: "workspace-durable",
    schema,
    initial: { version: 1, profile, targets: {}, bindings: {}, records: {} },
    events: { transition: z.array(operation).min(1).max(250) },
    budgets: {
      maxStateBytes: limits.stateBytes,
      maxEventBytes: 1024 * 1024,
      maxRevisions: 20000,
      maxCommitMs: 5000,
    },
    reduce(state, event) {
      const next = { ...state };
      for (const op of event.payload)
        next[op.section] = { ...next[op.section], [op.key]: op.value };
      return next;
    },
  });
  // Keep node:sqlite out of ordinary stateless commands.
  const { createSqliteStateDriver } = await import(
    "@agent-bundle/runtime/state/sqlite"
  );
  const driver = createSqliteStateDriver({ file: join(dir, "relay.sqlite") });
  let store;
  try {
    store = await driver.open(definition);
    await protectRelayDirectory(dir, limits.diskBytes);
  } catch (error) {
    await driver.close();
    throw new Error(
      "Relay state/profile could not be opened: " + error.message,
      { cause: error },
    );
  }
  let snapshot = await store.read(),
    queue = Promise.resolve(),
    closed = false;
  if (snapshot.state.profile !== profile) {
    await driver.close();
    throw new Error("Relay profile mismatch");
  }
  return {
    dir,
    limits,
    read: () => snapshot.state,
    inspect: () => store.inspect(),
    commit(ops) {
      const run = queue.then(async () => {
        if (closed) throw new Error("Relay state closed");
        operation.array().parse(ops);
        const changes = ops.filter(
          (op) =>
            JSON.stringify(snapshot.state[op.section][op.key]) !==
            JSON.stringify(op.value),
        );
        if (!changes.length) return snapshot.state;
        for (const section of Object.keys(sections)) {
          const keys = new Set([
            ...Object.keys(snapshot.state[section]),
            ...changes
              .filter((op) => op.section === section)
              .map((op) => op.key),
          ]);
          if (keys.size > limits[section])
            throw new Error("Relay capacity exceeded");
        }
        await protectRelayDirectory(dir, limits.diskBytes);
        snapshot = await store.dispatch("transition", changes, {
          idempotencyKey: randomUUID(),
          expectedRevision: snapshot.revision,
        });
        const journal = await store.inspect();
        if (journal.records >= 8 || journal.journalBytes > 8 * 1024 * 1024)
          snapshot = await store.compact({
            expectedRevision: snapshot.revision,
          });
        await protectRelayDirectory(dir, limits.diskBytes);
        return snapshot.state;
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run;
    },
    async close() {
      await queue;
      if (!closed) {
        closed = true;
        await driver.close();
      }
    },
  };
}
