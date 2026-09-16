import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { openRelayState, relayId } from "./state.js";
import { createRelayCodex } from "./codex.js";
import {
  hash,
  op,
  records,
  messageText,
  receipt,
  createRecordFactory,
} from "./records.js";
import { createIntake } from "./intake.js";
import { createCompletion } from "./completion.js";
import {
  connectGateway,
  resolveRef,
  getTranscriptTail,
  sendPrompt,
} from "../gateway.js";

function createGateway() {
  return {
    resolve: async (ref) => resolveRef(await connectGateway(), ref),
    tail: async (id) => getTranscriptTail(await connectGateway(), id, 200),
    send: async (id, text, extra) =>
      sendPrompt(
        await connectGateway({ signal: extra.signal }),
        id,
        text,
        extra,
      ),
  };
}
/** Core owns policy and durable intents; its caller must hold the single-worker lock. */
export async function openRelayEngine({
  stateDir,
  profile,
  env = process.env,
  gateway = createGateway(),
  clock = Date.now,
  openSession,
  openConversation,
  limits,
} = {}) {
  relayId.parse(profile);
  const state = await openRelayState({
    dir:
      stateDir ??
      env.GROK_BOT_RELAY_DIR ??
      join(homedir(), ".grok-bot-cli", "relay", hash(profile).slice(0, 24)),
    profile,
    limits,
  });
  const controller = new AbortController();
  let closed = false,
    queue = Promise.resolve(),
    lastError = null,
    reconcileOffset = 0;
  const codex = createRelayCodex({
    env,
    read: state.read,
    signal: controller.signal,
    clock,
    openSession,
    openConversation,
  });
  const stoppedBindings = new Set();
  const bindingControllers = new Map();
  function submissionSignal(record) {
    if (!record.bindingId) return controller.signal;
    if (!bindingControllers.has(record.bindingId))
      bindingControllers.set(record.bindingId, new AbortController());
    const scoped = bindingControllers.get(record.bindingId);
    if (
      stoppedBindings.has(record.bindingId) ||
      state.read().bindings[record.bindingId]?.state !== "running"
    )
      scoped.abort();
    return AbortSignal.any([controller.signal, scoped.signal]);
  }
  const runnable = (r) =>
    !closed &&
    (!r.bindingId ||
      (!stoppedBindings.has(r.bindingId) &&
        state.read().bindings[r.bindingId]?.state === "running"));
  const change = async (section, value) => state.commit([op(section, value)]);
  const update = async (id, patch) =>
    change("records", { ...state.read().records[id], ...patch });
  const { envelope, newRecord } = createRecordFactory({ env, clock });
  const { baseline, poll } = createIntake({
    state,
    gateway,
    clock,
    newRecord,
    stoppedBindings,
  });
  const completions = createCompletion({
    state,
    codex,
    update,
    newRecord,
    runnable,
  });
  function serial(fn) {
    const work = queue.then(() => {
      if (closed) throw new Error("Relay engine closed");
      return fn();
    });
    queue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  async function route(input) {
    if (
      input.busyPolicy !== undefined &&
      !["steer", "reject"].includes(input.busyPolicy)
    )
      throw new Error("Unsupported busy policy");
    if (input.bindingId) {
      const b = state.read().bindings[input.bindingId];
      if (!b || b.state !== "running")
        throw new Error("Unknown or stopped binding");
      if (input.grokTarget !== undefined) {
        const target = await gateway.resolve(input.grokTarget);
        if (relayId.parse(target.id) !== b.targetId)
          throw new Error("Explicit Grok target does not match binding");
      }
      await codex.verify(b);
      return { ...b, busyPolicy: input.busyPolicy ?? b.busyPolicy };
    }
    const threadId = relayId.parse(input.codexThreadId),
      target = await gateway.resolve(input.grokTarget),
      targetId = relayId.parse(target.id);
    const verified = await codex.verify({
      threadId,
      expectedCwd: input.expectedCwd,
    });
    const busyPolicy = input.busyPolicy ?? "steer";
    return { targetId, threadId, expectedCwd: verified.cwd, busyPolicy };
  }
  async function submit(id) {
    let r = state.read().records[id];
    if (r.submission !== "prepared" || !runnable(r)) return r;
    if (r.kind === "codex") {
      try {
        await codex.prepare(r);
      } catch {
        await update(id, { execution: "paused", reason: "codex-disconnected" });
        return state.read().records[id];
      }
    }
    if (!runnable(r)) return state.read().records[id];
    // A persisted sending intent is always uncertain on restart, regardless of client ID.
    await update(id, {
      submission: "sending",
      execution: "pending",
      reason: null,
    });
    r = state.read().records[id];
    let result;
    try {
      const signal = submissionSignal(r);
      if (!runnable(r) || signal.aborted) {
        result = { delivery: "rejected", reason: "cancelled" };
      } else if (r.kind === "codex") {
        result = await codex.send(r, { signal });
      } else {
        result = await gateway.send(r.targetId, r.text, {
          signal,
          clientNonce: r.clientId,
          ...(r.sourceIds[0] ? { replyToId: r.sourceIds[0] } : {}),
        });
      }
    } catch (error) {
      result = {
        delivery: error.delivery === "rejected" ? "rejected" : "unknown",
        reason:
          error.delivery === "rejected"
            ? error.reason === "cancelled"
              ? "cancelled"
              : "submission-rejected"
            : "transport-uncertain",
      };
    }
    const delivery = ["accepted", "rejected", "unknown"].includes(
      result?.delivery,
    )
      ? result.delivery
      : "unknown";
    await update(id, {
      submission: delivery,
      messageId:
        typeof result?.messageId === "string" ? result.messageId : null,
      turnId: typeof result?.turnId === "string" ? result.turnId : null,
      reason:
        delivery === "unknown"
          ? "delivery-unknown"
          : delivery === "rejected"
            ? (result.reason ?? "rejected").slice(0, 1024)
            : null,
    });
    return state.read().records[id];
  }
  async function startBinding(input) {
    const id = "binding:" + hash(input.requestId ?? randomUUID()),
      fingerprint = hash({ ...input, requestId: undefined });
    const old = state.read().bindings[id];
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error("Idempotency conflict");
      return old;
    }
    const r = await route(input);
    if (
      Object.values(state.read().bindings).some(
        (b) => b.targetId === r.targetId && b.state === "running",
      )
    )
      throw new Error("Grok target already has an active binding");
    // Bring existing tracked requests to a safe checkpoint before starting the new link.
    if (state.read().targets[r.targetId]) await poll(r.targetId, true);
    await baseline(r.targetId);
    if (state.read().targets[r.targetId].state !== "running")
      throw new Error("Target coverage is paused");
    const binding = {
      id,
      ...r,
      state: "running",
      createdAt: clock(),
      createdCursor: state.read().targets[r.targetId].cursor,
      fingerprint,
    };
    await change("bindings", binding);
    return binding;
  }
  async function send(kind, input) {
    const id = "exchange:" + hash(input.requestId ?? randomUUID()),
      fingerprint = hash({ kind, ...input, requestId: undefined });
    const old = state.read().records[id];
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error("Idempotency conflict");
      return receipt(old);
    }
    const text = messageText(input.message);
    envelope(input);
    const r = await route(input);
    await baseline(r.targetId);
    if (state.read().targets[r.targetId].state !== "running")
      throw new Error("Target coverage is paused");
    const record = newRecord(kind, id, r, text, {
      ...input,
      fingerprint,
      returnToGrok: kind === "codex",
    });
    await change("records", record);
    return receipt(await submit(id));
  }
  async function reconcile() {
    const candidates = records(state.read()).filter(
      (r) =>
        r.kind === "codex" &&
        ["sending", "unknown"].includes(r.submission) &&
        runnable(r),
    );
    const selected = Array.from(
      { length: Math.min(20, candidates.length) },
      (_, index) => candidates[(reconcileOffset + index) % candidates.length],
    );
    reconcileOffset = candidates.length
      ? (reconcileOffset + selected.length) % candidates.length
      : 0;
    for (const r of selected) {
      if (!runnable(r)) continue;
      try {
        const observed = await codex.reconcile(r);
        if (observed)
          await update(r.id, {
            submission: "accepted",
            turnId: observed.turnId,
            messageId: r.clientId,
            reason: null,
          });
        else
          await update(r.id, {
            submission: "unknown",
            reason: "client-id-not-found",
          });
      } catch {
        await update(r.id, {
          submission: "unknown",
          reason: "history-coverage-unavailable",
        });
      }
    }
  }
  async function tick() {
    lastError = null;
    try {
      // Reconnect/reconcile receipts before admitting new inbound deliveries.
      await reconcile();
      await completions();
      for (const target of Object.values(state.read().targets)) {
        const needed =
          Object.values(state.read().bindings).some(
            (b) => b.targetId === target.id && b.state === "running",
          ) ||
          records(state.read()).some(
            (r) =>
              r.targetId === target.id && runnable(r) && r.kind !== "codex",
          );
        if (needed) await poll(target.id);
      }
      for (const r of records(state.read())
        .filter((r) => r.submission === "prepared" && runnable(r))
        .slice(0, 20))
        await submit(r.id);
      await completions();
      for (const r of records(state.read())
        .filter(
          (r) =>
            r.kind === "grok-return" &&
            r.submission === "prepared" &&
            runnable(r),
        )
        .slice(0, 20))
        await submit(r.id);
    } catch (error) {
      lastError = /capacity|budget/i.test(error.message)
        ? "capacity"
        : "relay-error";
      throw error;
    }
    return status();
  }
  function status({ bindingId, limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Status limit must be 1..100");
    const s = state.read();
    if (bindingId && !s.bindings[bindingId]) throw new Error("Unknown binding");
    const selected = records(s).filter(
      (r) => !bindingId || r.bindingId === bindingId,
    );
    return {
      profile,
      generation: codex.generation,
      codex: codex.connection,
      state: closed ? "stopped" : lastError ? "paused" : "running",
      reason: lastError,
      bindings: Object.values(s.bindings).filter(
        (b) => !bindingId || b.id === bindingId,
      ),
      targets: Object.values(s.targets).filter(
        (t) => !bindingId || s.bindings[bindingId].targetId === t.id,
      ),
      receipts: selected.slice(-limit).map((r) => ({
        ...receipt(r),
        returnDelivery: r.returnId ? s.records[r.returnId]?.submission : null,
      })),
      receiptCount: selected.length,
      interactions: codex.interactions
        .list()
        .filter((i) => !bindingId || i.bindingIds.includes(bindingId)),
      interactionOverflow: codex.interactions.overflow,
    };
  }
  return {
    stateDir: state.dir,
    startBinding: (input) => serial(() => startBinding(input)),
    sendToGrok: (input) => serial(() => send("grok-request", input)),
    sendToCodex: (input) => serial(() => send("codex", input)),
    tick: () => serial(tick),
    status,
    async stopBinding({ bindingId }) {
      const b = state.read().bindings[bindingId];
      if (!b) throw new Error("Unknown binding");
      stoppedBindings.add(bindingId);
      bindingControllers.get(bindingId)?.abort();
      await change("bindings", { ...b, state: "stopped" });
      if (
        !Object.values(state.read().bindings).some(
          (b) => b.state === "running",
        ) &&
        !records(state.read()).some((r) => !r.bindingId)
      )
        await codex.close();
      return state.read().bindings[bindingId];
    },
    respond: (input) => codex.interactions.respond(input),
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await codex.close();
      await queue;
      await state.close();
    },
  };
}
