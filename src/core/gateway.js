import { randomUUID } from "node:crypto";
import { ensureSandboxHeaders, headersFromEnsureSandbox, headersFromEnv, mergeGatewayHeaders, normalizeHeaderMap, requestHeaders } from "./headers.js";
import { hasGrokBotGatewaySession, loadGrokBotGatewaySession } from "./app-session.js";
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS } from "./store.js";
import { assertAllowedCredentialUrl, redactSecrets } from "./url-policy.js";

export class GatewayError extends Error {
  constructor(message, { status, method } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.method = method;
  }
}

// ponytail: fixed 30 s deadline and buffered byte cap; upgrade path is per-method budgets plus streaming reads.
export const GATEWAY_TIMEOUT_MS = 30000;
export const GATEWAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function assertGatewayActive(signal) {
  if (signal?.aborted) {
    const error = new GatewayError("Gateway submission cancelled before transmission");
    error.delivery = "rejected";
    error.reason = "cancelled";
    throw error;
  }
}

function gatewayDeadline(signal) {
  const timeout = AbortSignal.timeout(GATEWAY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function backendBase() {
  return (
    process.env.SAND_BACKEND_URL ||
    process.env.CURSOR_API_BASE_URL ||
    "https://api2.cursor.sh"
  ).replace(/\/$/, "");
}

function accessTokenFromEnv() {
  return (
    process.env.CURSOR_ACCESS_TOKEN ||
    process.env.GROK_BOT_ACCESS_TOKEN ||
    process.env.SAND_ACCESS_TOKEN ||
    ""
  ).trim();
}

function gatewayTokenFromEnv() {
  return (
    process.env.GROK_BOT_GATEWAY_TOKEN ||
    process.env.SAND_HOST_GATEWAY_TOKEN ||
    process.env.SAND_GATEWAY_TOKEN ||
    ""
  ).trim();
}

function gatewayOverride() {
  const token = gatewayTokenFromEnv();
  const explicitUrl = (process.env.GROK_BOT_GATEWAY_URL || process.env.SAND_HOST_GATEWAY_URL || "").trim();
  const localUrl = token
    ? "http://127.0.0.1:" + (process.env.SAND_HOST_PORT || "1340")
    : "";
  const url = explicitUrl || localUrl;
  if (url && token) {
    return {
      gatewayUrl: assertAllowedCredentialUrl(url.replace(/\/$/, ""), { kind: "gateway" }),
      gatewayToken: token,
      gatewayHeaders: headersFromEnv(),
    };
  }
  return null;
}

function sessionFromApp() {
  let loaded;
  try {
    loaded = loadGrokBotGatewaySession();
  } catch (error) {
    // Descriptor present but unusable (e.g. Windows Local State missing). Fall
    // through to CURSOR_ACCESS_TOKEN → EnsureSandBox when that token is set.
    if (accessTokenFromEnv()) return null;
    throw error instanceof Error ? new GatewayError(error.message) : error;
  }
  if (!loaded) return null;
  return {
    gatewayUrl: assertAllowedCredentialUrl(loaded.gatewayUrl, { kind: "gateway" }),
    gatewayToken: loaded.gatewayToken,
    gatewayHeaders: mergeGatewayHeaders(normalizeHeaderMap(loaded.headers), headersFromEnv()),
  };
}

export function hasGatewayAuth() {
  return Boolean(gatewayOverride() || accessTokenFromEnv() || hasGrokBotGatewaySession());
}

async function readTextCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new GatewayError("Gateway response too large (over " + maxBytes + " bytes)");
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength ?? value.length;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new GatewayError("Gateway response too large (over " + maxBytes + " bytes)");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength ?? c.length))).toString("utf8");
}

async function readJson(res) {
  const text = await readTextCapped(res, GATEWAY_MAX_RESPONSE_BYTES);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

export async function ensureSandbox(accessToken, { signal } = {}) {
  assertGatewayActive(signal);
  const url = assertAllowedCredentialUrl(backendBase(), { kind: "backend" }) + "/aiserver.v1.GrokBotService/EnsureSandBox";
  let res, body;
  try {
    res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: gatewayDeadline(signal),
      headers: ensureSandboxHeaders(accessToken),
      body: "{}",
    });
    body = await readJson(res);
  } catch (error) {
    assertGatewayActive(signal);
    throw error;
  }
  assertGatewayActive(signal);
  if (!res.ok) {
    const detail = body.message || body.error || body.raw || res.statusText;
    throw new GatewayError("EnsureSandBox failed: " + res.status + " " + redactSecrets(detail), { status: res.status, method: "EnsureSandBox" });
  }
  const gatewayUrl = pick(body, "gatewayUrl", "gateway_url");
  const gatewayToken = pick(body, "gatewayToken", "gateway_token");
  if (!gatewayUrl || !gatewayToken) {
    throw new GatewayError("EnsureSandBox returned no gatewayUrl/gatewayToken. Auth may be a dashboard API key (those do not work).");
  }
  return { gatewayUrl: assertAllowedCredentialUrl(String(gatewayUrl).replace(/\/$/, ""), { kind: "gateway" }), gatewayToken: String(gatewayToken), gatewayHeaders: mergeGatewayHeaders(headersFromEnsureSandbox(body), headersFromEnv()) };
}

export async function connectGateway({ signal } = {}) {
  assertGatewayActive(signal);
  const override = gatewayOverride();
  if (override) return override;
  const fromApp = sessionFromApp();
  if (fromApp) return fromApp;
  const token = accessTokenFromEnv();
  if (!token) {
    throw new GatewayError("Set CURSOR_ACCESS_TOKEN, or GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN. Do not use a Cursor dashboard API key.");
  }
  return ensureSandbox(token, { signal });
}

export async function gatewayCall(session, method, body = {}, { signal } = {}) {
  assertGatewayActive(signal);
  const base = assertAllowedCredentialUrl(session.gatewayUrl, { kind: "gateway" });
  const url = base + "/api/" + method;
  // Cancellation can abort read/auth preflights. Once a prompt request starts,
  // observe its actual receipt (or timeout) instead of losing certainty on stop.
  const prompt = method === "sendPrompt";
  const options = {
    method: "POST",
    redirect: "error",
    signal: gatewayDeadline(prompt ? undefined : signal),
    headers: requestHeaders(session),
    body: JSON.stringify(body),
  };
  assertGatewayActive(signal); // Final synchronous boundary before transmission.
  let res, data;
  try {
    res = await fetch(url, options);
    data = await readJson(res);
  } catch (error) {
    if (!prompt) assertGatewayActive(signal);
    throw error;
  }
  if (!prompt) assertGatewayActive(signal);
  if (!res.ok) {
    const detail = data.message || data.error || data.raw || res.statusText;
    throw new GatewayError(method + " failed: " + res.status + " " + redactSecrets(String(detail).slice(0, 300)), { status: res.status, method });
  }
  return data;
}

function asRecord(agent) {
  if (!agent) return null;
  const id = agent.id || agent.agentId;
  const memberIds = agent.memberIds || agent.memberAgentIds || [];
  const notify = agent.notifyOnUpdatesEnabled ?? agent.notifyOnAgentUpdates;
  const hidden = agent.isHiddenFromSidebar ?? agent.hiddenFromSidebar;
  return {
    id,
    name: agent.name || "",
    title: agent.title || "",
    description: agent.description || "",
    avatarShape: agent.avatarShape || "",
    avatarColor: agent.avatarColor || "",
    ...(notify !== undefined ? { notifyOnAgentUpdates: Boolean(notify) } : {}),
    ...(hidden !== undefined ? { hiddenFromSidebar: Boolean(hidden) } : {}),
    isGroup: agent.isGroup === true || (agent.isGroup == null && Array.isArray(memberIds) && memberIds.length > 0),
    memberIds: Array.isArray(memberIds) ? memberIds : [],
  };
}

function assertAvatar(kind, value, allowed) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  if (!allowed.includes(trimmed)) {
    throw new GatewayError("Unknown avatar " + kind + " \"" + value + "\". Use: " + allowed.join(" "));
  }
  return trimmed;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.agents)) return data.agents;
  if (data.agent) return [data.agent];
  return [];
}

function unwrapOne(data) {
  return asRecord(data.agent || data);
}

export async function listAgents(session, { signal } = {}) {
  const data = await gatewayCall(session, "listAgents", {}, { signal });
  return unwrapList(data).map(asRecord).filter((r) => r && r.id);
}

function resolveFromList(records, ref) {
  const needle = String(ref).trim().toLowerCase();
  const byId = records.find((r) => r.id.toLowerCase() === needle);
  if (byId) return byId;
  const matches = records.filter((r) => r.name.toLowerCase() === needle || r.title.toLowerCase() === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new GatewayError("No bot or group named \"" + ref + "\"");
  throw new GatewayError("Ambiguous name \"" + ref + "\"");
}

export async function resolveRef(session, ref, { signal } = {}) {
  return resolveFromList(await listAgents(session, { signal }), ref);
}

export async function createAgent(session, input) {
  const data = await gatewayCall(session, "createAgent", {
    name: input.name,
    description: input.description || "",
    title: input.title || "",
    avatarShape: assertAvatar("shape", input.avatarShape, AVATAR_SHAPES),
    avatarColor: assertAvatar("color", input.avatarColor, AVATAR_COLORS),
    origin: "user",
  });
  return unwrapOne(data);
}

export async function updateAgent(session, ref, patch = {}) {
  const rec = await resolveRef(session, ref);
  if (patch.name !== undefined && !String(patch.name).trim()) {
    throw new GatewayError("Name cannot be blank.");
  }
  const profile = {
    name: patch.name !== undefined ? String(patch.name).trim() : rec.name,
    description: patch.description !== undefined ? String(patch.description) : rec.description,
  };
  if (patch.title !== undefined) profile.title = String(patch.title);
  if (patch.avatarShape !== undefined) profile.avatarShape = assertAvatar("shape", patch.avatarShape, AVATAR_SHAPES);
  if (patch.avatarColor !== undefined) profile.avatarColor = assertAvatar("color", patch.avatarColor, AVATAR_COLORS);
  await gatewayCall(session, "updateAgent", { id: rec.id, profile });
  if (patch.notifyOnAgentUpdates !== undefined) {
    await gatewayCall(session, "setAgentNotifyOnUpdates", { id: rec.id, isEnabled: Boolean(patch.notifyOnAgentUpdates) });
  }
  if (patch.hiddenFromSidebar !== undefined) {
    await gatewayCall(session, "setAgentHiddenFromSidebar", { id: rec.id, isHidden: Boolean(patch.hiddenFromSidebar) });
  }
  const fresh = (await listAgents(session)).find((r) => r.id === rec.id);
  return fresh || rec;
}

export async function deleteAgent(session, ref) {
  const rec = await resolveRef(session, ref);
  await gatewayCall(session, "deleteAgent", { id: rec.id });
  return rec;
}

function normalizeMemberIds(records, memberRefs) {
  const memberIds = new Set();
  for (const ref of memberRefs) {
    const rec = resolveFromList(records, ref);
    if (rec.isGroup) {
      throw new GatewayError(`Cannot add group "${rec.name}" as a member. Nested groups are not allowed.`);
    }
    memberIds.add(rec.id);
  }
  if (memberIds.size === 0) {
    throw new GatewayError("A group needs at least one existing member agent.");
  }
  if (memberIds.size > MAX_GROUP_MEMBERS) {
    throw new GatewayError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  }
  return [...memberIds];
}

export async function createGroup(session, input) {
  const records = await listAgents(session);
  const memberAgentIds = normalizeMemberIds(records, input.memberIds || []);
  const data = await gatewayCall(session, "createGroup", {
    name: input.name,
    description: input.description || "",
    memberAgentIds,
  });
  const rec = unwrapOne(data);
  const extras = {};
  if (input.title) extras.title = input.title;
  if (input.avatarShape) extras.avatarShape = input.avatarShape;
  if (input.avatarColor) extras.avatarColor = input.avatarColor;
  if (Object.keys(extras).length && rec?.id) return updateAgent(session, rec.id, extras);
  return rec;
}

export async function setGroupMembers(session, groupRef, memberRefs) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const memberAgentIds = normalizeMemberIds(records, memberRefs);
  const data = await gatewayCall(session, "setGroupMembers", {
    id: group.id,
    memberAgentIds,
  });
  return unwrapOne(data) || { ...group, memberIds: memberAgentIds, isGroup: true };
}

export async function addGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = [...new Set([...group.memberIds, member.id])];
  return setGroupMembers(session, group.id, next);
}

export async function removeGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  if (!group.isGroup) throw new GatewayError(`"${group.name}" is a bot, not a group.`);
  const member = resolveFromList(records, memberRef);
  const next = group.memberIds.filter((id) => id !== member.id);
  return setGroupMembers(session, group.id, next);
}

export async function sendPrompt(session, ref, prompt, extra = {}) {
  assertGatewayActive(extra.signal);
  const rec = await resolveRef(session, ref, { signal: extra.signal });
  const body = {
    agentId: rec.id,
    prompt,
    clientNonce: extra.clientNonce || randomUUID(),
  };
  if (extra.replyToId) body.replyToId = extra.replyToId;
  let data;
  try {
    data = await gatewayCall(session, "sendPrompt", body, { signal: extra.signal });
  } catch (err) {
    // Delivery states: the server answered no (rejected) vs the request may have landed (unknown).
    // Never retry an unknown delivery blindly; read the thread first.
    if (err && err.delivery == null) {
      err.delivery = err instanceof GatewayError && err.status != null && err.status < 500 ? "rejected" : "unknown";
    }
    if (err && err.targetId == null) err.targetId = rec.id;
    if (err && err.delivery === "unknown" && err instanceof Error && !/delivery unknown/.test(err.message)) {
      err.message += " (delivery unknown; check the thread before resending)";
    }
    throw err;
  }
  const messageId = data && typeof data === "object" && typeof data.messageId === "string" ? data.messageId : null;
  // Only a confirmed receipt counts as accepted; anything else is unknown, never a silent accept.
  // ponytail: full send/execution correlation envelope stays in #37.
  return { target: rec, result: data && typeof data === "object" ? data : {}, delivery: messageId ? "accepted" : "unknown", ...(messageId ? { messageId } : {}) };
}

export async function getTranscriptTail(session, ref, limit = 40) {
  const rec = await resolveRef(session, ref);
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const data = await gatewayCall(session, "getAgentTranscriptTail", { id: rec.id, limit: bounded });
  return { target: rec, transcript: data };
}

export async function getThread(session, ref, rootId) {
  const rec = await resolveRef(session, ref);
  const data = await gatewayCall(session, "getAgentThread", { id: rec.id, rootId });
  return { target: rec, thread: data };
}
