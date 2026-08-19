import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROUP_JSON_VERSION = 1;
export const MAX_GROUP_MEMBERS = 6;
export const PROFILE_FILE = "profile.json";
export const GROUP_FILE = "group.json";
export const SETTINGS_FILE = "settings.json";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isUuid(value) {
  return UUID_RE.test(value);
}

export function defaultCandidateRoots() {
  const home = homedir();
  const env = [
    process.env.GROK_BOT_AGENTS_DIR,
    process.env.SAND_AGENTS_DIR,
    process.env.SAND_DATA_ROOT && join(process.env.SAND_DATA_ROOT, "agents"),
    process.env.SAND_DATA_ROOT && join(process.env.SAND_DATA_ROOT, "agent-data", "agents"),
  ].filter(Boolean);

  return [
    ...env,
    "/home/box/agent-data/agents",
    "/home/box/sand-data/agents",
    join(home, ".grokbot", "agent-data", "agents"),
    join(home, ".grokbot", "sand-data", "agents"),
    join(home, "Library", "Application Support", "Grok Bot", "agent-data", "agents"),
    join(home, "Library", "Application Support", "Grok Bot", "sand-data", "agents"),
  ];
}

export function looksLikeAgentsRoot(dir) {
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.some(
    (e) => e.isDirectory() && isUuid(e.name) && existsSync(join(dir, e.name, PROFILE_FILE)),
  );
}

export function resolveAgentsRoot(explicit) {
  if (explicit) {
    mkdirSync(explicit, { recursive: true });
    return explicit;
  }
  for (const candidate of defaultCandidateRoots()) {
    if (looksLikeAgentsRoot(candidate)) return candidate;
  }
  throw new StoreError(
    "Could not find a Grok Bot agents directory. Pass --dir or set GROK_BOT_AGENTS_DIR.\nThe macOS app keeps the live roster on its cloud computer (agent-data/agents), not in ~/Library/Application Support/Grok Bot.",
  );
}

function readProfile(dir) {
  const path = join(dir, PROFILE_FILE);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  return {
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    title: String(raw.title ?? ""),
    avatarShape: String(raw.avatarShape ?? ""),
    avatarColor: String(raw.avatarColor ?? ""),
  };
}

function readGroup(dir) {
  const path = join(dir, GROUP_FILE);
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  const memberIds = Array.isArray(raw.memberIds) ? raw.memberIds.map(String) : [];
  return {
    version: Number(raw.version ?? GROUP_JSON_VERSION),
    memberIds,
  };
}

export function listRecords(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isUuid(entry.name)) continue;
    const dir = join(root, entry.name);
    const profile = readProfile(dir);
    if (!profile) continue;
    const group = readGroup(dir);
    out.push({
      id: entry.name,
      path: dir,
      ...profile,
      isGroup: group != null,
      memberIds: group?.memberIds ?? [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function resolveRef(root, ref) {
  const records = listRecords(root);
  if (isUuid(ref)) {
    const exact = records.find((r) => r.id.toLowerCase() === ref.toLowerCase());
    if (!exact) throw new StoreError(`No bot or group with id ${ref}`);
    return exact;
  }
  const needle = ref.trim().toLowerCase();
  const matches = records.filter(
    (r) => r.name.toLowerCase() === needle || r.title.toLowerCase() === needle,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new StoreError(`No bot or group named "${ref}"`);
  throw new StoreError(
    `Ambiguous name "${ref}": ${matches.map((m) => `${m.name} (${m.id})`).join(", ")}`,
  );
}

function writeProfile(dir, profile) {
  writeJson(join(dir, PROFILE_FILE), {
    name: profile.name.trim(),
    description: (profile.description ?? "").trim(),
    title: (profile.title ?? "").trim(),
    avatarShape: (profile.avatarShape ?? "").trim(),
    avatarColor: (profile.avatarColor ?? "").trim(),
  });
}

function writeSettings(dir) {
  writeJson(join(dir, SETTINGS_FILE), { notifyOnAgentUpdates: true });
}

function writeGroup(dir, memberIds) {
  writeJson(join(dir, GROUP_FILE), {
    version: GROUP_JSON_VERSION,
    memberIds,
  });
}

function normalizeMemberIds(root, memberRefs, { groupId } = {}) {
  const records = listRecords(root);
  const byId = new Map(records.map((r) => [r.id, r]));
  const groups = new Set(records.filter((r) => r.isGroup).map((r) => r.id));
  const resolved = [];
  const seen = new Set();
  for (const ref of memberRefs) {
    const rec = resolveRef(root, ref);
    if (groups.has(rec.id)) {
      throw new StoreError(`Cannot add group "${rec.name}" as a member. Nested groups are not allowed.`);
    }
    if (groupId && rec.id === groupId) continue;
    if (!byId.has(rec.id)) continue;
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    resolved.push(rec.id);
  }
  if (resolved.length > MAX_GROUP_MEMBERS) {
    throw new StoreError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`);
  }
  return resolved;
}

export function createAgent(root, input) {
  const name = (input.name ?? "").trim();
  if (!name) throw new StoreError("Name is required.");
  const id = randomUUID();
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(dir, "automations"), { recursive: true });
  writeProfile(dir, {
    name,
    description: input.description ?? "",
    title: input.title ?? "",
    avatarShape: input.avatarShape ?? "",
    avatarColor: input.avatarColor ?? "",
  });
  writeSettings(dir);
  return resolveRef(root, id);
}

export function deleteAgent(root, ref) {
  const rec = resolveRef(root, ref);
  rmSync(rec.path, { recursive: true, force: true });
  for (const other of listRecords(root).filter((r) => r.isGroup)) {
    if (!other.memberIds.includes(rec.id)) continue;
    writeGroup(
      other.path,
      other.memberIds.filter((id) => id !== rec.id),
    );
  }
  return rec;
}

export function createGroup(root, input) {
  const memberIds = normalizeMemberIds(root, input.memberIds ?? []);
  if (memberIds.length === 0) {
    throw new StoreError("A group needs at least one existing member agent.");
  }
  const existing = listRecords(root).find(
    (r) =>
      r.isGroup &&
      r.memberIds.length === memberIds.length &&
      r.memberIds.every((id) => memberIds.includes(id)),
  );
  if (existing) return existing;
  const group = createAgent(root, {
    name: input.name,
    description: input.description ?? "",
    title: input.title ?? "",
  });
  writeGroup(join(root, group.id), memberIds);
  return resolveRef(root, group.id);
}

export function setGroupMembers(root, groupRef, memberRefs) {
  const group = resolveRef(root, groupRef);
  if (!group.isGroup) throw new StoreError(`"${group.name}" is a bot, not a group.`);
  const memberIds = normalizeMemberIds(root, memberRefs, { groupId: group.id });
  if (memberIds.length === 0) {
    throw new StoreError("A group needs at least one existing member agent.");
  }
  writeGroup(group.path, memberIds);
  return resolveRef(root, group.id);
}

export function addGroupMember(root, groupRef, memberRef) {
  const group = resolveRef(root, groupRef);
  return setGroupMembers(root, group.id, [...group.memberIds, memberRef]);
}

export function removeGroupMember(root, groupRef, memberRef) {
  const group = resolveRef(root, groupRef);
  const member = resolveRef(root, memberRef);
  return setGroupMembers(root, group.id, group.memberIds.filter((id) => id !== member.id));
}
