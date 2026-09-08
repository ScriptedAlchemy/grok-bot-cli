#!/usr/bin/env node
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS, StoreError, defaultCandidateRoots, looksLikeAgentsRoot, resolveAgentsRoot } from "./store.js";
import { hasGatewayAuth } from "./gateway.js";
import { openBackend } from "./commands.js";
import { inspectGrokBotGatewaySession } from "./app-session.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryText, normalizeTranscript } from "./transcript.js";

const MAX_STDIN_MESSAGE_BYTES = 64 * 1024;

function print(value) {
  if (typeof value === "string") process.stdout.write(value + "\n");
  else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function fail(err) {
  let message = err instanceof Error ? err.message : String(err);
  message = message.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer <redacted>");
  process.stderr.write(message + "\n");
  process.exit(1);
}

function usage() {
  return [
    "gbot - manage Grok Bot agents and groups",
    "",
    "Usage:",
    "  gbot [--dir DIR] [--json] <command>",
    "",
    "Commands:",
    "  doctor",
    "  bots list",
    "  bots create --name NAME [--description TEXT] [--instructions TEXT] [--title TEXT]",
    "           [--avatar-shape SHAPE] [--avatar-color COLOR]",
    "  bots update <id-or-name> [--name NAME] [--description TEXT] [--instructions TEXT]",
    "           [--title TEXT] [--avatar-shape SHAPE] [--avatar-color COLOR]",
    "           [--notify on|off] [--hidden on|off]",
    "  bots get <id-or-name>",
    "  bots delete <id-or-name>",
    "  groups list",
    "  groups create --name NAME --member ID_OR_NAME [--member ...]",
    "           [--description TEXT] [--instructions TEXT] [--title TEXT]",
    "           [--avatar-shape SHAPE] [--avatar-color COLOR]",
    "  groups update <id-or-name>  (same flags as bots update; members stay on set/add/remove)",
    "  groups get <id-or-name>",
    "  groups members <id-or-name>",
    "  groups add <group> <bot>",
    "  groups remove <group> <bot>",
    "  groups set <group> --member ID [--member ...]",
    "  groups delete <id-or-name>",
    "  send <bot-or-group> <message...>",
    "  send <bot-or-group> --stdin",
    "  thread <bot-or-group> [--limit N] [--root MESSAGE_ID] [--json --normalized]",
    "  chat <bot-or-group>     alias for thread",
    "",
    "Max group members: " + MAX_GROUP_MEMBERS,
    "--description / --instructions is the UI Instructions field (same key).",
    "Avatar shapes: " + AVATAR_SHAPES.join(" "),
    "Avatar colors: " + AVATAR_COLORS.join(" "),
    "Flags: --gateway  --files  --dir DIR  --json  --stdin  --normalized",
    "Auth: GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN, or the Grok Bot app session, or CURSOR_ACCESS_TOKEN",
    "File fallback: GROK_BOT_AGENTS_DIR",
  ].join("\n");
}

function takeFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value == null || value.startsWith("-")) throw new StoreError(name + " needs a value");
  args.splice(i, 2);
  return value;
}

function takeLastFlag(args, ...names) {
  let value;
  let seen = false;
  for (;;) {
    let hit = false;
    for (const name of names) {
      const i = args.indexOf(name);
      if (i === -1) continue;
      const next = args[i + 1];
      if (next == null || next.startsWith("-")) throw new StoreError(name + " needs a value");
      args.splice(i, 2);
      value = next;
      seen = true;
      hit = true;
      break;
    }
    if (!hit) break;
  }
  return seen ? value : undefined;
}

function takeRepeating(args, name) {
  const out = [];
  for (;;) {
    const value = takeFlag(args, name);
    if (value == null) break;
    out.push(value);
  }
  return out;
}

function hasFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function parseOnOff(value, flag) {
  const v = String(value).trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
  if (v === "off" || v === "false" || v === "0" || v === "no") return false;
  throw new StoreError(flag + " must be on|off (or true|false|1|0|yes|no)");
}

function takeCreateFields(args) {
  return {
    name: takeFlag(args, "--name"),
    description: takeLastFlag(args, "--description", "--instructions") ?? "",
    title: takeFlag(args, "--title") ?? "",
    avatarShape: takeFlag(args, "--avatar-shape") ?? "",
    avatarColor: takeFlag(args, "--avatar-color") ?? "",
  };
}

function takeUpdatePatch(args) {
  const name = takeFlag(args, "--name");
  const description = takeLastFlag(args, "--description", "--instructions");
  const title = takeFlag(args, "--title");
  const avatarShape = takeFlag(args, "--avatar-shape");
  const avatarColor = takeFlag(args, "--avatar-color");
  const notifyRaw = takeFlag(args, "--notify");
  const hiddenRaw = takeFlag(args, "--hidden");
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (title !== undefined) patch.title = title;
  if (avatarShape !== undefined) patch.avatarShape = avatarShape;
  if (avatarColor !== undefined) patch.avatarColor = avatarColor;
  if (notifyRaw !== undefined) patch.notifyOnAgentUpdates = parseOnOff(notifyRaw, "--notify");
  if (hiddenRaw !== undefined) patch.hiddenFromSidebar = parseOnOff(hiddenRaw, "--hidden");
  if (Object.keys(patch).length === 0) {
    throw new StoreError("update needs at least one of --name --description --instructions --title --avatar-shape --avatar-color --notify --hidden");
  }
  return patch;
}

function summarize(rec) {
  return {
    id: rec.id,
    name: rec.name,
    title: rec.title || undefined,
    description: rec.description || undefined,
    avatarShape: rec.avatarShape || undefined,
    avatarColor: rec.avatarColor || undefined,
    ...(rec.notifyOnAgentUpdates !== undefined ? { notifyOnAgentUpdates: rec.notifyOnAgentUpdates } : {}),
    ...(rec.hiddenFromSidebar !== undefined ? { hiddenFromSidebar: rec.hiddenFromSidebar } : {}),
    kind: rec.isGroup ? "group" : "bot",
    members: rec.isGroup ? rec.memberIds : undefined,
  };
}

function done(json, rec, text, printImpl = print) {
  printImpl(json ? summarize(rec) : text);
}

function formatRecord(rec, all) {
  const kind = rec.isGroup ? "group" : "bot";
  const members = rec.isGroup
    ? rec.memberIds.map((id) => {
        const m = all.find((r) => r.id === id);
        return m ? m.name + " (" + id + ")" : id;
      }).join(", ")
    : "";
  const title = rec.title ? " - " + rec.title : "";
  const desc = rec.description ? "\n    " + rec.description : "";
  const avatar = rec.avatarShape || rec.avatarColor
    ? "\n    avatar: " + [rec.avatarShape, rec.avatarColor].filter(Boolean).join(" ")
    : "";
  const settings = [];
  if (rec.notifyOnAgentUpdates !== undefined) settings.push("notify " + (rec.notifyOnAgentUpdates ? "on" : "off"));
  if (rec.hiddenFromSidebar !== undefined) settings.push("hidden " + (rec.hiddenFromSidebar ? "on" : "off"));
  const settingsLine = settings.length ? "\n    " + settings.join(", ") : "";
  const extra = rec.isGroup ? "\n    members (" + rec.memberIds.length + "): " + (members || "(none)") : "";
  return kind + "  " + rec.name + title + "\n    " + rec.id + desc + avatar + settingsLine + extra;
}

function formatTranscript(out) {
  const rec = out.target;
  const payload = out.transcript || out.thread || {};
  const entries = payload.entries || payload.messages || payload.items || (Array.isArray(payload) ? payload : []);
  const header = (rec.isGroup ? "group" : "bot") + "  " + rec.name + "\n    " + rec.id;
  if (!Array.isArray(entries) || entries.length === 0) {
    return header + "\n    (no messages)";
  }
  const lines = [header, ""];
  for (const e of entries) {
    const role = e.role || e.kind || e.sender || e.type || "msg";
    const text = entryText(e);
    const id = e.id || e.messageId || "";
    lines.push("[" + role + (id ? " " + id : "") + "] " + String(text).slice(0, 400));
  }
  return lines.join("\n");
}

async function readStdinMessage(stdin) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_STDIN_MESSAGE_BYTES) {
      throw new StoreError("stdin message must be at most 64 KiB.");
    }
    chunks.push(bytes);
  }
  if (byteLength === 0) throw new StoreError("stdin message must not be empty.");

  let message;
  try {
    message = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new StoreError("stdin message must be valid UTF-8.");
  }
  if (message.includes("\0")) throw new StoreError("stdin message must not contain a NUL byte.");
  if (message.trim() !== message) {
    throw new StoreError("stdin message must not have surrounding whitespace.");
  }
  return message;
}

export async function main(argv, options = {}) {
  const openBackendImpl = options.openBackendImpl ?? openBackend;
  const stdin = options.stdin ?? process.stdin;
  const printImpl = options.printImpl ?? print;
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printImpl(usage());
    return;
  }

  const json = hasFlag(args, "--json");
  const gateway = hasFlag(args, "--gateway");
  const filesMode = hasFlag(args, "--files");
  const stdinMode = hasFlag(args, "--stdin");
  const normalized = hasFlag(args, "--normalized");
  const rootFlag = takeFlag(args, "--dir");
  const cmd = args[0];
  const sub = args[1];
  const rest = args.slice(2);
  if (!cmd) {
    printImpl(usage());
    return;
  }
  if (stdinMode && cmd !== "send") throw new StoreError("--stdin is only valid with send.");
  if (normalized && cmd !== "thread" && cmd !== "chat") {
    throw new StoreError("--normalized is only valid with thread or chat.");
  }
  if (normalized && !json) throw new StoreError("--normalized requires --json.");
  if (stdinMode && rest.length > 0) {
    throw new StoreError("--stdin cannot be combined with a positional message.");
  }

  let stdinMessage;
  if (stdinMode) {
    if (!sub) throw new StoreError("gbot send <bot-or-group> --stdin");
    stdinMessage = await readStdinMessage(stdin);
  }

  if (cmd === "doctor") {
    const candidates = defaultCandidateRoots();
    const found = candidates.filter(looksLikeAgentsRoot);
    let resolved = null;
    try {
      resolved = resolveAgentsRoot(rootFlag);
    } catch (err) {
      if (!(err instanceof StoreError)) throw err;
    }
    const note = "Live roster is on the box. Prefer CURSOR_ACCESS_TOKEN then EnsureSandBox then POST gateway /api/*.";
    const gatewayAuthPresent = hasGatewayAuth();
    const grokBotAppSession = inspectGrokBotGatewaySession();
    const payload = { resolved, found, candidates, gatewayAuthPresent, grokBotAppSession, note };
    if (json) printImpl(payload);
    else {
      printImpl("resolved: " + (resolved ?? "(none)"));
      printImpl("gateway auth: " + (gatewayAuthPresent ? "present" : "no"));
      if (grokBotAppSession.usable) printImpl("Grok Bot app session: usable");
      else if (grokBotAppSession.present) printImpl("Grok Bot app session: present but unusable: " + grokBotAppSession.error);
      else printImpl("Grok Bot app session: not found");
      printImpl("found:");
      printImpl(found.length ? found.map((p) => "  " + p).join("\n") : "  (none)");
      printImpl("candidates:");
      for (const c of candidates) printImpl("  " + c);
      printImpl(note);
    }
    return;
  }

  const backend = await openBackendImpl({ root: rootFlag, gateway, files: filesMode });

  if (cmd === "bots" && sub === "list") {
    const rows = (await backend.list()).filter((r) => !r.isGroup);
    if (json) printImpl(rows.map(summarize));
    else if (rows.length === 0) printImpl("No bots.");
    else printImpl(rows.map((r) => formatRecord(r, rows)).join("\n\n"));
    return;
  }

  if (cmd === "bots" && sub === "create") {
    const fields = takeCreateFields(rest);
    const rec = await backend.createAgent(fields);
    done(json, rec, "Created bot " + rec.name + " (" + rec.id + ")", printImpl);
    return;
  }

  if (cmd === "bots" && sub === "update") {
    const ref = rest.shift();
    if (!ref || ref.startsWith("-")) throw new StoreError("gbot bots update <id-or-name> [--name NAME] ...");
    const rec = await backend.updateAgent(ref, takeUpdatePatch(rest));
    done(json, rec, "Updated " + (rec.isGroup ? "group" : "bot") + " " + rec.name + " (" + rec.id + ")", printImpl);
    return;
  }

  if (cmd === "bots" && (sub === "get" || sub === "delete")) {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot bots " + sub + " <id-or-name>");
    if (sub === "get") {
      const rec = await backend.resolve(ref);
      if (json) printImpl(summarize(rec));
      else printImpl(formatRecord(rec, await backend.list()));
      return;
    }
    const rec = await backend.deleteAgent(ref);
    done(json, rec, "Deleted " + (rec.isGroup ? "group" : "bot") + " " + rec.name + " (" + rec.id + ")", printImpl);
    return;
  }

  if (cmd === "groups" && sub === "list") {
    const all = await backend.list();
    const rows = all.filter((r) => r.isGroup);
    if (json) printImpl(rows.map(summarize));
    else if (rows.length === 0) printImpl("No groups.");
    else printImpl(rows.map((r) => formatRecord(r, all)).join("\n\n"));
    return;
  }

  if (cmd === "groups" && sub === "delete") {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot groups delete <id-or-name>");
    const rec = await backend.resolve(ref);
    if (!rec.isGroup) throw new StoreError('"' + rec.name + '" is a bot, not a group. Use bots delete.');
    const deleted = await backend.deleteAgent(ref);
    done(json, deleted, "Deleted group " + deleted.name + " (" + deleted.id + ")", printImpl);
    return;
  }

  if (cmd === "groups" && sub === "create") {
    const fields = takeCreateFields(rest);
    const members = takeRepeating(rest, "--member");
    const rec = await backend.createGroup({ ...fields, memberIds: members });
    done(json, rec, "Created group " + rec.name + " (" + rec.id + ") with " + rec.memberIds.length + " members", printImpl);
    return;
  }

  if (cmd === "groups" && sub === "update") {
    const ref = rest.shift();
    if (!ref || ref.startsWith("-")) throw new StoreError("gbot groups update <id-or-name> [--name NAME] ...");
    const current = await backend.resolve(ref);
    if (!current.isGroup) throw new StoreError('"' + current.name + '" is a bot, not a group. Use bots update.');
    const rec = await backend.updateAgent(ref, takeUpdatePatch(rest));
    done(json, rec, "Updated group " + rec.name + " (" + rec.id + ")", printImpl);
    return;
  }

  if (cmd === "groups" && (sub === "get" || sub === "members")) {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot groups " + sub + " <id-or-name>");
    const rec = await backend.resolve(ref);
    if (!rec.isGroup) throw new StoreError('"' + rec.name + '" is a bot, not a group.');
    if (json) printImpl(summarize(rec));
    else printImpl(formatRecord(rec, await backend.list()));
    return;
  }

  if (cmd === "groups" && (sub === "add" || sub === "remove")) {
    const group = rest[0];
    const bot = rest[1];
    if (!group || !bot) throw new StoreError("gbot groups " + sub + " <group> <bot>");
    const rec = sub === "add"
      ? await backend.addGroupMember(group, bot)
      : await backend.removeGroupMember(group, bot);
    const verb = sub === "add" ? "Added to " : "Removed from ";
    done(json, rec, verb + rec.name + ". Members: " + rec.memberIds.length, printImpl);
    return;
  }

  if (cmd === "groups" && sub === "set") {
    const group = rest.shift();
    const members = takeRepeating(rest, "--member");
    if (!group) throw new StoreError("gbot groups set <group> --member ID [--member ...]");
    const rec = await backend.setGroupMembers(group, members);
    done(json, rec, "Updated " + rec.name + ". Members: " + rec.memberIds.length, printImpl);
    return;
  }

  if (cmd === "send") {
    const ref = sub;
    const message = stdinMode ? stdinMessage : rest.join(" ").trim();
    if (!ref || !message) throw new StoreError("gbot send <bot-or-group> <message...>");
    const out = await backend.send(ref, message);
    if (json) printImpl({ id: out.target.id, name: out.target.name, kind: out.target.isGroup ? "group" : "bot", result: out.result });
    else printImpl("Sent to " + (out.target.isGroup ? "group" : "bot") + " " + out.target.name + " (" + out.target.id + ")");
    return;
  }

  if (cmd === "thread" || cmd === "chat") {
    const ref = sub;
    if (!ref) throw new StoreError("gbot thread <bot-or-group> [--limit N] [--root MESSAGE_ID]");
    const limitRaw = takeFlag(rest, "--limit");
    const rootId = takeFlag(rest, "--root");
    const limit = limitRaw ? Number(limitRaw) : 40;
    const out = rootId ? await backend.thread(ref, rootId) : await backend.transcript(ref, limit);
    if (normalized) printImpl(normalizeTranscript(out));
    else if (json) printImpl(out);
    else printImpl(formatTranscript(out));
    return;
  }

  throw new StoreError(usage());
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) main(process.argv).catch(fail);
