import { entryText, sourceEntryId } from "../transcript.js";
import { op, hash, MAX_TEXT, pageEntries, messageText } from "./records.js";

/** Correlate the whole page before atomically recording intake and advancing its checkpoint. */
export function createIntake({
  state,
  gateway,
  clock,
  newRecord,
  stoppedBindings,
}) {
  const change = (section, value) => state.commit([op(section, value)]);
  async function baseline(targetId) {
    if (state.read().targets[targetId]) return;
    const page = pageEntries(await gateway.tail(targetId));
    await change("targets", {
      id: targetId,
      cursor: page.length ? sourceEntryId(page.at(-1)) : null,
      baseline: true,
      state: "running",
      reason: null,
      nextPoll: 0,
      failures: 0,
    });
  }
  async function poll(targetId, force = false) {
    let target = state.read().targets[targetId];
    if (target.state === "paused" || (!force && target.nextPoll > clock()))
      return;
    let page;
    try {
      page = pageEntries(await gateway.tail(targetId));
    } catch (error) {
      const coverage =
          error.name === "ZodError" || /coverage/.test(error.message),
        auth = [401, 403].includes(error.status);
      await change("targets", {
        ...target,
        state: coverage || auth ? "paused" : "backoff",
        reason: coverage
          ? "invalid-coverage"
          : auth
            ? "auth"
            : "gateway-disconnected",
        failures: target.failures + 1,
        nextPoll:
          clock() + Math.min(30000, 1000 * 2 ** Math.min(target.failures, 5)),
      });
      return;
    }
    const current = page.length ? sourceEntryId(page.at(-1)) : null;
    const index =
      target.cursor === null
        ? -1
        : page.findIndex((e) => sourceEntryId(e) === target.cursor);
    if (
      (target.cursor !== null && index === -1) ||
      (target.cursor === null && page.length === 200)
    ) {
      await change("targets", {
        ...target,
        state: "paused",
        reason: "gap",
        observedCursor: current,
      });
      return;
    }
    const local = { ...state.read().records },
      changes = [];
    // Gather every nonce before classifying bot outputs, even if its user row comes later.
    for (const entry of page) {
      if (typeof entry.clientNonce !== "string") continue;
      const matches = Object.values(local).filter(
        (r) =>
          r.targetId === targetId &&
          r.kind !== "codex" &&
          r.clientId === entry.clientNonce,
      );
      if (!matches.length) continue;
      if (typeof entry.requestId !== "string" || !entry.requestId) {
        await change("targets", {
          ...target,
          state: "paused",
          reason: "correlation-missing",
        });
        return;
      }
      for (const r of matches) {
        if (r.requestId && r.requestId !== entry.requestId) {
          await change("targets", {
            ...target,
            state: "paused",
            reason: "correlation-conflict",
          });
          return;
        }
        const next = {
          ...r,
          submission: "accepted",
          requestId: entry.requestId,
          messageId: sourceEntryId(entry),
          reason: null,
        };
        local[r.id] = next;
        changes.push(op("records", next));
      }
    }
    const own = new Set(
      Object.values(local)
        .filter(
          (r) =>
            r.targetId === targetId && r.kind === "grok-return" && r.requestId,
        )
        .map((r) => r.requestId),
    );
    const requests = new Map(
      Object.values(local)
        .filter(
          (r) =>
            r.targetId === targetId && r.kind === "grok-request" && r.requestId,
        )
        .map((r) => [r.requestId, r]),
    );
    const binding = Object.values(state.read().bindings).find(
      (b) =>
        b.targetId === targetId &&
        b.state === "running" &&
        !stoppedBindings.has(b.id),
    );
    const unresolved = Object.values(local).some(
      (r) =>
        r.targetId === targetId &&
        r.kind !== "codex" &&
        ["sending", "unknown", "accepted"].includes(r.submission) &&
        !r.requestId,
    );
    const incoming = page.slice(index + 1);
    for (const entry of incoming) {
      if (entry.kind !== "send-message" || own.has(entry.requestId)) continue;
      const parent = requests.get(entry.requestId);
      // Without nonce coverage, unsolicited classification could echo a return or misroute a reply.
      if (!parent && unresolved) {
        await state.commit([
          ...changes,
          op("targets", {
            ...target,
            state: "backoff",
            reason: "correlation-pending",
            nextPoll: clock() + 2000,
          }),
        ]);
        return;
      }
      const destination = parent ?? binding;
      if (!destination) continue;
      if (parent && parent.hop + 1 >= parent.maxHops) {
        await state.commit([
          ...changes,
          op("targets", { ...target, state: "paused", reason: "hop-limit" }),
        ]);
        return;
      }
      const sourceId = sourceEntryId(entry),
        id = "inbound:" + hash([targetId, sourceId]);
      if (local[id]) continue;
      let body;
      try {
        body = messageText(entryText(entry));
      } catch {
        await change("targets", {
          ...target,
          state: "paused",
          reason: "message-size",
        });
        return;
      }
      const text = `[Grok sender ${targetId}; message ${sourceId}]\n${parent ? "Reply to a tracked request. Your next final answer is not returned automatically." : "Linked conversation. Your corresponding final answer returns automatically to Grok."}\n\n${body}`;
      if (Buffer.byteLength(text) > MAX_TEXT) {
        await change("targets", {
          ...target,
          state: "paused",
          reason: "message-size",
        });
        return;
      }
      const record = newRecord("codex", id, destination, text, {
        sourceIds: [sourceId],
        parentId: parent?.id,
        returnToGrok: !parent,
        correlationId: parent?.correlationId,
        hop: parent ? parent.hop + 1 : 0,
        maxHops: parent?.maxHops,
      });
      local[id] = record;
      changes.push(op("records", record));
    }
    target = {
      ...target,
      cursor: current,
      reason: null,
      state: "running",
      failures: 0,
      nextPoll: 0,
    };
    try {
      await state.commit([...changes, op("targets", target)]);
    } catch (error) {
      if (/capacity|budget/i.test(error.message)) {
        await change("targets", {
          ...state.read().targets[targetId],
          state: "paused",
          reason: "capacity",
        });
        return;
      }
      throw error;
    }
  }
  return { baseline, poll };
}
