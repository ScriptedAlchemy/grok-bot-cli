import { randomUUID } from "node:crypto";
import { ensureSandboxHeaders, headersFromEnsureSandbox, headersFromEnv, mergeGatewayHeaders, normalizeHeaderMap, requestHeaders } from "./headers.js";
import { hasGrokBotGatewaySession, loadGrokBotGatewaySession } from "./app-session.js";
import { AVATAR_COLORS, AVATAR_SHAPES } from "./store.js";

export class GatewayError extends Error {
  constructor(message, { status, method } = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.method = method;
  }
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
  if (url && token) return { gatewayUrl: url.replace(/\/$/, ""), gatewayToken: token, gatewayHeaders: headersFromEnv() };
  return null;
}

function sessionFromApp() {
  const loaded = loadGrokBotGatewaySession();
  if (!loaded) return null;
  return {
    gatewayUrl: loaded.gatewayUrl,
    gatewayToken: loaded.gatewayToken,
    gatewayHeaders: mergeGatewayHeaders(normalizeHeaderMap(loaded.headers), headersFromEnv()),
  };
}

export function hasGatewayAuth() {
  return Boolean(gatewayOverride() || accessTokenFromEnv() || hasGrokBotGatewaySession());
}

async function readJson(res) {
  const text = await res.text();
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

export async function ensureSandbox(accessToken) {
  const url = backendBase() + "/aiserver.v1.GrokBotService/EnsureSandBox";
  const res = await fetch(url, {
    method: "POST",
    headers: ensureSandboxHeaders(accessToken),
    body: "{}",
  });
  const body = await readJson(res);
  if (!res.ok) {
    const detail = body.message || body.error || body.raw || res.statusText;
    throw new GatewayError("EnsureSandBox failed: " + res.status + " " + detail, { status: res.status, method: "EnsureSandBox" });
  }
  const gatewayUrl = pick(body, "gatewayUrl", "gateway_url");
  const gatewayToken = pick(body, "gatewayToken", "gateway_token");
  if (!gatewayUrl || !gatewayToken) {
    throw new GatewayError("EnsureSandBox returned no gatewayUrl/gatewayToken. Auth may be a dashboard API key (those do not work).");
  }
  return { gatewayUrl: String(gatewayUrl).replace(/\/$/, ""), gatewayToken: String(gatewayToken), gatewayHeaders: mergeGatewayHeaders(headersFromEnsureSandbox(body), headersFromEnv()) };
}

export async function connectGateway() {
  const override = gatewayOverride();
  if (override) return override;
  const fromApp = sessionFromApp();
  if (fromApp) return fromApp;
  const token = accessTokenFromEnv();
  if (!token) {
    throw new GatewayError("Set CURSOR_ACCESS_TOKEN, or GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN. Do not use a Cursor dashboard API key.");
  }
  return ensureSandbox(token);
}

export async function gatewayCall(session, method, body = {}) {
  const url = session.gatewayUrl + "/api/" + method;
  const res = await fetch(url, {
    method: "POST",
    headers: requestHeaders(session),
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) {
    const detail = data.message || data.error || data.raw || res.statusText;
    throw new GatewayError(method + " failed: " + res.status + " " + String(detail).slice(0, 300), { status: res.status, method });
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

export async function listAgents(session) {
  const data = await gatewayCall(session, "listAgents", {});
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

export async function resolveRef(session, ref) {
  return resolveFromList(await listAgents(session), ref);
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

export async function createGroup(session, input) {
  const records = await listAgents(session);
  const memberAgentIds = (input.memberIds || []).map((ref) => resolveFromList(records, ref).id);
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
  const memberAgentIds = memberRefs.map((ref) => resolveFromList(records, ref).id);
  const data = await gatewayCall(session, "setGroupMembers", {
    id: group.id,
    memberAgentIds,
  });
  return unwrapOne(data) || { ...group, memberIds: memberAgentIds, isGroup: true };
}

export async function addGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  const member = resolveFromList(records, memberRef);
  const next = [...new Set([...group.memberIds, member.id])];
  return setGroupMembers(session, group.id, next);
}

export async function removeGroupMember(session, groupRef, memberRef) {
  const records = await listAgents(session);
  const group = resolveFromList(records, groupRef);
  const member = resolveFromList(records, memberRef);
  const next = group.memberIds.filter((id) => id !== member.id);
  return setGroupMembers(session, group.id, next);
}

export async function sendPrompt(session, ref, prompt, extra = {}) {
  const rec = await resolveRef(session, ref);
  const body = {
    agentId: rec.id,
    prompt,
    clientNonce: extra.clientNonce || randomUUID(),
  };
  if (extra.replyToId) body.replyToId = extra.replyToId;
  const data = await gatewayCall(session, "sendPrompt", body);
  return { target: rec, result: data };
}

export async function getTranscriptTail(session, ref, limit = 50) {
  const rec = await resolveRef(session, ref);
  const data = await gatewayCall(session, "getAgentTranscriptTail", { id: rec.id, limit });
  return { target: rec, transcript: data };
}

export async function getThread(session, ref, rootId) {
  const rec = await resolveRef(session, ref);
  const data = await gatewayCall(session, "getAgentThread", { id: rec.id, rootId });
  return { target: rec, thread: data };
}
