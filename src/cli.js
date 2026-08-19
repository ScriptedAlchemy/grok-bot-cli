#!/usr/bin/env node
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS, StoreError, defaultCandidateRoots, looksLikeAgentsRoot, resolveAgentsRoot } from "./store.js";
import { hasGatewayAuth } from "./gateway.js";
import { openBackend } from "./commands.js";

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
    "  thread <bot-or-group> [--limit N] [--root MESSAGE_ID]",
    "  chat <bot-or-group>     alias for thread",
    "",
    "Max group members: " + MAX_GROUP_MEMBERS,
    "--description / --instructions is the UI Instructions field (same key).",
    "Avatar shapes: " + AVATAR_SHAPES.join(" "),
    "Avatar colors: " + AVATAR_COLORS.join(" "),
    "Flags: --gateway  --files  --dir DIR  --json",
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

function done(json, rec, text) {
  print(json ? summarize(rec) : text);
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

function entryText(e) {
  if (!e || typeof e !== "object") return "";
  const direct = e.text || e.prompt || e.message || e.preview;
  if (typeof direct === "string" && direct) return direct;
  const content = e.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return part.text || part.content || "";
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  return "";
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

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    print(usage());
    return;
  }

  const json = hasFlag(args, "--json");
  const gateway = hasFlag(args, "--gateway");
  const filesMode = hasFlag(args, "--files");
  const rootFlag = takeFlag(args, "--dir");
  const cmd = args[0];
  const sub = args[1];
  const rest = args.slice(2);
  if (!cmd) {
    print(usage());
    return;
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
    const payload = { resolved, found, candidates, gatewayAuthPresent: hasGatewayAuth(), note };
    if (json) print(payload);
    else {
      print("resolved: " + (resolved ?? "(none)"));
      print("gateway auth: " + (hasGatewayAuth() ? "yes (env)" : "no"));
      print("found:");
      print(found.length ? found.map((p) => "  " + p).join("\n") : "  (none)");
      print("candidates:");
      for (const c of candidates) print("  " + c);
      print(note);
    }
    return;
  }

  const backend = await openBackend({ root: rootFlag, gateway, files: filesMode });

  if (cmd === "bots" && sub === "list") {
    const rows = (await backend.list()).filter((r) => !r.isGroup);
    if (json) print(rows.map(summarize));
    else if (rows.length === 0) print("No bots.");
    else print(rows.map((r) => formatRecord(r, rows)).join("\n\n"));
    return;
  }

  if (cmd === "bots" && sub === "create") {
    const fields = takeCreateFields(rest);
    const rec = await backend.createAgent(fields);
    done(json, rec, "Created bot " + rec.name + " (" + rec.id + ")");
    return;
  }

  if (cmd === "bots" && sub === "update") {
    const ref = rest.shift();
    if (!ref || ref.startsWith("-")) throw new StoreError("gbot bots update <id-or-name> [--name NAME] ...");
    const rec = await backend.updateAgent(ref, takeUpdatePatch(rest));
    done(json, rec, "Updated " + (rec.isGroup ? "group" : "bot") + " " + rec.name + " (" + rec.id + ")");
    return;
  }

  if (cmd === "bots" && (sub === "get" || sub === "delete")) {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot bots " + sub + " <id-or-name>");
    if (sub === "get") {
      const rec = await backend.resolve(ref);
      if (json) print(summarize(rec));
      else print(formatRecord(rec, await backend.list()));
      return;
    }
    const rec = await backend.deleteAgent(ref);
    done(json, rec, "Deleted " + (rec.isGroup ? "group" : "bot") + " " + rec.name + " (" + rec.id + ")");
    return;
  }

  if (cmd === "groups" && sub === "list") {
    const all = await backend.list();
    const rows = all.filter((r) => r.isGroup);
    if (json) print(rows.map(summarize));
    else if (rows.length === 0) print("No groups.");
    else print(rows.map((r) => formatRecord(r, all)).join("\n\n"));
    return;
  }

  if (cmd === "groups" && sub === "delete") {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot groups delete <id-or-name>");
    const rec = await backend.resolve(ref);
    if (!rec.isGroup) throw new StoreError('"' + rec.name + '" is a bot, not a group. Use bots delete.');
    const deleted = await backend.deleteAgent(ref);
    done(json, deleted, "Deleted group " + deleted.name + " (" + deleted.id + ")");
    return;
  }

  if (cmd === "groups" && sub === "create") {
    const fields = takeCreateFields(rest);
    const members = takeRepeating(rest, "--member");
    const rec = await backend.createGroup({ ...fields, memberIds: members });
    done(json, rec, "Created group " + rec.name + " (" + rec.id + ") with " + rec.memberIds.length + " members");
    return;
  }

  if (cmd === "groups" && sub === "update") {
    const ref = rest.shift();
    if (!ref || ref.startsWith("-")) throw new StoreError("gbot groups update <id-or-name> [--name NAME] ...");
    const current = await backend.resolve(ref);
    if (!current.isGroup) throw new StoreError('"' + current.name + '" is a bot, not a group. Use bots update.');
    const rec = await backend.updateAgent(ref, takeUpdatePatch(rest));
    done(json, rec, "Updated group " + rec.name + " (" + rec.id + ")");
    return;
  }

  if (cmd === "groups" && (sub === "get" || sub === "members")) {
    const ref = rest[0];
    if (!ref) throw new StoreError("gbot groups " + sub + " <id-or-name>");
    const rec = await backend.resolve(ref);
    if (!rec.isGroup) throw new StoreError('"' + rec.name + '" is a bot, not a group.');
    if (json) print(summarize(rec));
    else print(formatRecord(rec, await backend.list()));
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
    done(json, rec, verb + rec.name + ". Members: " + rec.memberIds.length);
    return;
  }

  if (cmd === "groups" && sub === "set") {
    const group = rest.shift();
    const members = takeRepeating(rest, "--member");
    if (!group) throw new StoreError("gbot groups set <group> --member ID [--member ...]");
    const rec = await backend.setGroupMembers(group, members);
    done(json, rec, "Updated " + rec.name + ". Members: " + rec.memberIds.length);
    return;
  }

  if (cmd === "send") {
    const ref = sub;
    const message = rest.join(" ").trim();
    if (!ref || !message) throw new StoreError("gbot send <bot-or-group> <message...>");
    const out = await backend.send(ref, message);
    if (json) print({ id: out.target.id, name: out.target.name, kind: out.target.isGroup ? "group" : "bot", result: out.result });
    else print("Sent to " + (out.target.isGroup ? "group" : "bot") + " " + out.target.name + " (" + out.target.id + ")");
    return;
  }

  if (cmd === "thread" || cmd === "chat") {
    const ref = sub;
    if (!ref) throw new StoreError("gbot thread <bot-or-group> [--limit N] [--root MESSAGE_ID]");
    const limitRaw = takeFlag(rest, "--limit");
    const rootId = takeFlag(rest, "--root");
    const limit = limitRaw ? Number(limitRaw) : 40;
    const out = rootId ? await backend.thread(ref, rootId) : await backend.transcript(ref, limit);
    if (json) print(out);
    else print(formatTranscript(out));
    return;
  }

  throw new StoreError(usage());
}

main(process.argv).catch(fail);
