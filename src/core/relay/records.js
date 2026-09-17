import { createHash, randomUUID } from "node:crypto";
import { sourceEntryId, transcriptEntries } from "../transcript.js";
import { canonicalJson } from "@agent-bundle/runtime/state";
import { buildEnvelope } from "../codex-bridge.js";
import { relayId } from "./state.js";
export const hash = (value) =>
  createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(value))))
    .digest("hex");
export const op = (section, value) => ({ section, key: value.id, value });
export const terminal = (r) =>
  ["completed", "failed", "interrupted"].includes(r.execution);
export const records = (s) => Object.values(s.records);
export const MAX_TEXT = 65536;
export function messageText(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > MAX_TEXT
  )
    throw new Error("Relay message must contain text within 64 KiB");
  return value;
}
export function pageEntries(payload) {
  const raw = payload?.transcript ?? payload;
  if (!raw || Array.isArray(raw) || !Array.isArray(raw.entries))
    throw new Error("Invalid transcript coverage envelope");
  const page = transcriptEntries(raw);
  if (page.length > 200)
    throw new Error("Transcript coverage exceeds 200 entries");
  const ids = new Set();
  for (const e of page) {
    const id = sourceEntryId(e);
    relayId.parse(id);
    if (ids.has(id) || typeof e.kind !== "string" || !e.kind)
      throw new Error("Invalid transcript coverage");
    ids.add(id);
  }
  return page;
}
export function receipt(record) {
  return {
    exchangeId: record.id,
    kind: record.kind,
    target: { id: record.targetId },
    clientId: record.clientId,
    correlationId: record.correlationId,
    requestId: record.requestId,
    sourceIds: record.sourceIds.slice(0, 8),
    sourceCount: record.sourceIds.length,
    returnId: record.returnId,
    hop: record.hop,
    maxHops: record.maxHops,
    delivery: record.submission,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.turnId ? { turnId: record.turnId } : {}),
    replyRoute: {
      mode: "auto",
      threadId: record.threadId,
      targetId: record.targetId,
      bindingId: record.bindingId,
    },
    execution: record.execution,
    reason: record.reason,
  };
}

export function createRecordFactory({ env, clock }) {
  function envelope(input = {}) {
    const canonical = buildEnvelope({
      correlationId: input.correlationId,
      hop: input.hop,
      env,
    });
    const maxHops = Math.min(
      input.maxHops ?? canonical.maxHops,
      canonical.maxHops,
    );
    if (!Number.isInteger(maxHops) || canonical.hop >= maxHops)
      throw new Error("Relay hop limit reached");
    return {
      hop: canonical.hop,
      maxHops,
      correlationId: canonical.correlationId,
    };
  }
  function newRecord(kind, id, r, text, input = {}) {
    return {
      id,
      kind,
      targetId: r.targetId,
      threadId: r.threadId,
      expectedCwd: r.expectedCwd,
      busyPolicy: r.busyPolicy,
      bindingId: r.bindingId ?? (r.id?.startsWith("binding:") ? r.id : null),
      text,
      sourceIds: input.sourceIds ?? [],
      parentId: input.parentId ?? null,
      returnToGrok: input.returnToGrok ?? false,
      clientId: randomUUID(),
      ...envelope(input),
      submission: "prepared",
      execution: "pending",
      reason: null,
      turnId: null,
      requestId: null,
      messageId: null,
      returnId: null,
      createdAt: clock(),
      fingerprint: input.fingerprint ?? hash([kind, id]),
    };
  }
  return { envelope, newRecord };
}
