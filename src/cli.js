#!/usr/bin/env node
import { AVATAR_COLORS, AVATAR_SHAPES, MAX_GROUP_MEMBERS, StoreError, defaultCandidateRoots, looksLikeAgentsRoot, resolveAgentsRoot } from "./store.js";
import { hasGatewayAuth } from "./gateway.js";
import { openBackend } from "./commands.js";
import { inspectGrokBotGatewaySession } from "./app-session.js";
import { entryText, transcriptDelta, transcriptEntries } from "./transcript.js";
import { historyPath, readHistory, saveHistory } from "./history.js";
import { redactSecrets } from "./url-policy.js";
import { buildEnvelope, codexStatus, listCodexQueue, listCodexThreads, sendToCodexThread, singleLine, stripTerminalControls, withEnvelopeHeader } from "./codex-bridge.js";

function print(value) {
  if (typeof value === "string") process.stdout.write(value + "\n");
  else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Exit 1 for every failure; `--json` callers read `reason` / `mode` / `delivery` instead of the exit code. */
function fail(err) {
  let message = err instanceof Error ? err.message : String(err);
  message = redactSecrets(message);
  if (jsonErrors && err instanceof Error) {
    const out = { error: message };
    for (const key of ["delivery", "reason", "mode", "threadId", "turnId", "targetId", "messageId", "correlationId"]) {
      if (err[key] !== undefined) out[key] = err[key];
    }
    if (out.reason === undefined && err instanceof StoreError) out.reason = "usage";
    if (err.envelope && typeof err.envelope === "object") {
      out.messageId = err.envelope.messageId;
      out.correlationId = err.envelope.correlationId;
      out.hop = err.envelope.hop;
    }
    process.stderr.write(JSON.stringify(out) + "\n");
  } else {
    process.stderr.write(message + "\n");
  }
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
    "  send [envelope flags] <bot-or-group> <message...>",
    "  thread <bot-or-group> [--limit N] [--after ENTRY_ID] [--root MESSAGE_ID] [--full]",
    "  chat <bot-or-group>     alias for thread",
    "  history [bot-or-group] [--search TEXT] [--limit N]  (offline)",
    "  history --path         print the local JSONL file path",
    "  codex status",
    "  codex list-threads [--limit N] [--cursor CURSOR]",
    "  codex send [envelope flags] [--when-busy reject|queue] <threadId> <message...>",
    "  codex queue <threadId>  (experimental: GROK_BOT_CODEX_EXPERIMENTAL=1)",
    "",
    "Envelope flags (before the target): --correlation-id ID  --reply-to MESSAGE_ID  --hop N  --envelope",
    "  Receipts carry messageId/correlationId/hop; a reply passes the original correlation id and hop+1.",
    "  Sends at hop >= GROK_BOT_MAX_HOPS (default 4) are refused. --envelope prepends the [gbot ...] header.",
    "",
    "Max group members: " + MAX_GROUP_MEMBERS,
    "--description / --instructions is the UI Instructions field (same key).",
    "Avatar shapes: " + AVATAR_SHAPES.join(" "),
    "Avatar colors: " + AVATAR_COLORS.join(" "),
    "Flags: --gateway  --files  --dir DIR  --json",
    "Auth: GROK_BOT_GATEWAY_URL + GROK_BOT_GATEWAY_TOKEN, or the Grok Bot app session, or CURSOR_ACCESS_TOKEN",
    "File fallback: GROK_BOT_AGENTS_DIR",
    "Codex: talks to the local app-server daemon socket under CODEX_HOME (default ~/.codex)",
    "       GROK_BOT_CODEX_THREADS=id,id restricts `codex send` to operator-approved threads",
    "History: opt-in plaintext JSONL at ~/.grok-bot-cli/history.jsonl",
    "         GROK_BOT_HISTORY=on to record; --history-dir / GROK_BOT_HISTORY_DIR to relocate",
    "         --no-history to skip one command",
  ].join("\n");
}

/** `opaque` values may start with `-` (pagination cursors); ordinary values may not. */
function takeFlag(args, name, { opaque = false } = {}) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value == null || value === "" || (!opaque && value.startsWith("-"))) throw new StoreError(name + " needs a value");
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

/** Peel a trailing flag that `--` does not protect; free-text commands keep mid-text tokens. */
function takeTrailingFlag(args, name) {
  const stop = args.indexOf("--");
  const end = stop === -1 ? args.length : stop;
  if (end > 0 && args[end - 1] === name) {
    args.splice(end - 1, 1);
    return true;
  }
  return false;
}

/** Peel global CLI options only from the leading argv (before the command). */
let jsonErrors = false;
function takeLeadingGlobals(args) {
  let json = false;
  let gateway = false;
  let files = false;
  let noHistory = false;
  let historyDir;
  let dir;
  while (args.length) {
    const a = args[0];
    if (a === "--") {
      args.shift();
      break;
    }
    if (a === "--json") {
      json = true;
      jsonErrors = true;
      args.shift();
      continue;
    }
    if (a === "--gateway") {
      gateway = true;
      args.shift();
      continue;
    }
    if (a === "--files") {
      files = true;
      args.shift();
      continue;
    }
    if (a === "--no-history") {
      noHistory = true;
      args.shift();
      continue;
    }
    if (a === "--history-dir") {
      args.shift();
      const value = args.shift();
      if (value == null || value.startsWith("-")) throw new StoreError("--history-dir needs a value");
      historyDir = value;
      continue;
    }
    if (a === "--dir") {
      args.shift();
      const value = args.shift();
      if (value == null || value.startsWith("-")) throw new StoreError("--dir needs a value");
      dir = value;
      continue;
    }
    break;
  }
  return { json, gateway, files, dir, noHistory, historyDir };
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

function formatTranscript(out, { full = false } = {}) {
  const rec = out.target;
  const payload = out.transcript || out.thread || {};
  const entries = transcriptEntries(payload);
  const header = (rec.isGroup ? "group" : "bot") + "  " + rec.name + "\n    " + rec.id;
  if (!Array.isArray(entries) || entries.length === 0) {
    return header + "\n    (no messages)";
  }
  const lines = [header, ""];
  for (const e of entries) {
    const role = e.role || e.kind || e.sender || e.type || "msg";
    const text = entryText(e);
    const id = e.id || e.messageId || "";
    lines.push("[" + role + (id ? " " + id : "") + "] " + (full ? text : truncateCliText(text)));
  }
  return lines.join("\n");
}

/** Bounded preview; --json/--full still retrieve the complete text. */
function truncateCliText(text, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "… [+" + (text.length - max) + " chars; --full or --json for complete text]";
}

function formatCodexStatus(s) {
  const lines = ["socket: " + s.socketPath + " (" + s.socketState + ")"];
  if (!s.reachable) return lines.concat("reachable: no (" + s.mode + ")", s.message).join("\n");
  if (s.mode !== "daemon") return lines.concat("reachable: yes, but unusable (" + s.mode + ")", s.message).join("\n");
  lines.push("reachable: yes (daemon)");
  const cli = s.cliVersion ?? (s.cliVersionProbe === "ok" ? "unknown" : "unknown, probe " + s.cliVersionProbe);
  lines.push("daemon version: " + (s.daemonVersion ?? "unknown") + "  cli version: " + cli + "  pinned schema: " + s.pinnedVersion + " (" + s.schema.compatibility + ")");
  lines.push("desktop attached: unknown (not observable from the socket)");
  if (s.versionMismatch) lines.push("warning: daemon and CLI versions differ; `codex app-server daemon restart` picks up the installed CLI");
  return lines.join("\n");
}

function formatCodexThread(t) {
  const title = t.name ? " - " + stripTerminalControls(t.name) : "";
  const preview = t.preview
    ? "\n    " + stripTerminalControls(String(t.preview).replace(/\s+/g, " ")).slice(0, 200)
    : "";
  return stripTerminalControls(t.id) + "  " + stripTerminalControls(t.status) + title + "\n    " + stripTerminalControls(t.cwd ?? "") + preview;
}

/** Structured subcommands accept only their documented flags; anything left over is an error. */
function rejectUnknownArgs(rest, usageLine) {
  if (rest.length) throw new StoreError("Unknown argument " + JSON.stringify(rest[0]) + ". Usage: " + usageLine);
}

/**
 * Envelope flags live before the free-text target so message bodies keep their own `--` tokens.
 * Returns a built envelope (or a hop-limit refusal) plus whether any flag was given.
 */
function takeEnvelopeFlags(rest, { busyPolicy = false } = {}) {
  let correlationId;
  let replyTo;
  let hop;
  let envelope = false;
  let whenBusy = "reject";
  for (;;) {
    const a = rest[0];
    if (busyPolicy && a === "--when-busy") {
      rest.shift();
      whenBusy = rest.shift();
      if (whenBusy !== "reject" && whenBusy !== "queue") throw new StoreError("--when-busy must be reject or queue");
      continue;
    }
    if (a === "--correlation-id") { rest.shift(); correlationId = rest.shift(); if (correlationId == null) throw new StoreError("--correlation-id needs a value"); continue; }
    if (a === "--reply-to") { rest.shift(); replyTo = rest.shift(); if (replyTo == null) throw new StoreError("--reply-to needs a value"); continue; }
    if (a === "--hop") {
      rest.shift();
      const raw = rest.shift();
      if (raw == null || !/^\d+$/.test(raw)) throw new StoreError("--hop must be a non-negative integer");
      hop = Number(raw);
      continue;
    }
    if (a === "--envelope") { rest.shift(); envelope = true; continue; }
    break;
  }
  try {
    return { envelope: buildEnvelope({ correlationId, replyTo, hop, envelope }), whenBusy };
  } catch (err) {
    if (err instanceof RangeError) throw new StoreError(err.message);
    throw err;
  }
}

async function codexStatusCommand(rest, json) {
  rejectUnknownArgs(rest, "gbot codex status [--json]");
  const status = await codexStatus();
  print(json ? status : formatCodexStatus(status));
  // Exit 0 only for a usable daemon; `mode` says why otherwise (reachable but off-schema included).
  if (!status.reachable || status.mode !== "daemon") process.exitCode = 1;
}

async function codexListCommand(rest, json) {
  const limitRaw = takeFlag(rest, "--limit");
  const cursor = takeFlag(rest, "--cursor", { opaque: true });
  rejectUnknownArgs(rest, "gbot codex list-threads [--limit N] [--cursor CURSOR] [--json]");
  const limit = limitRaw ? Number(limitRaw) : 20;
  let out;
  try {
    out = await listCodexThreads({ limit, cursor });
  } catch (err) {
    if (err instanceof RangeError) throw new StoreError(err.message);
    throw err;
  }
  if (json) print(out);
  else if (out.threads.length === 0) print("No Codex threads.");
  else print(out.threads.map(formatCodexThread).join("\n\n") + (out.nextCursor ? "\n\nmore: --cursor " + JSON.stringify(singleLine(out.nextCursor)) : ""));
}

async function codexQueueCommand(rest, json) {
  const threadId = rest.shift();
  rejectUnknownArgs(rest, "gbot codex queue <threadId> [--json]");
  if (!threadId || threadId.startsWith("-")) throw new StoreError("gbot codex queue <threadId> [--json]");
  const out = await listCodexQueue(threadId);
  if (json) print(out);
  else if (out.queued.length === 0) print("No queued submissions on Codex thread " + threadId + ".");
  else print(out.queued.map((q) => q.id + "  " + (q.clientUserMessageId ?? "") + "\n    " + singleLine(q.text).slice(0, 200)).join("\n\n"));
}

async function codexSendCommand(rest, json) {
  const { envelope, whenBusy } = takeEnvelopeFlags(rest, { busyPolicy: true });
  const threadId = rest.shift();
  if (rest[0] === "--") rest.shift();
  const message = rest.join(" ").trim();
  if (!threadId || threadId.startsWith("-") || !message) throw new StoreError("gbot codex send [envelope flags] [--when-busy reject|queue] <threadId> <message...>");
  const out = await sendToCodexThread(threadId, message, { envelope, whenBusy });
  if (json) print(out);
  else if (out.delivery === "queued") print("Queued " + out.queuedSubmissionId + " on busy Codex thread " + out.threadId + "; message " + out.messageId);
  else print("Started turn " + out.turnId + " (" + out.turnStatus + ") on Codex thread " + out.threadId + "; message " + out.messageId);
}

async function runCodex(sub, rest, json) {
  // Structured subcommands take no free text, so --json peels anywhere. Send
  // peels a trailing --json only; mid-message tokens stay message content.
  const structured = sub === "status" || sub === "list-threads" || sub === "queue";
  if (structured ? hasFlag(rest, "--json") : sub === "send" && takeTrailingFlag(rest, "--json")) { json = true; jsonErrors = true; }
  if (sub === "status") return codexStatusCommand(rest, json);
  if (sub === "list-threads") return codexListCommand(rest, json);
  if (sub === "queue") return codexQueueCommand(rest, json);
  if (sub === "send") return codexSendCommand(rest, json);
  throw new StoreError("gbot codex status | list-threads [--limit N] [--cursor CURSOR] | queue <threadId> | send [envelope flags] [--when-busy reject|queue] <threadId> <message...>");
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    print(usage());
    return;
  }

  // `json` may also be peeled later from command-local argv (trailing `--json`).
  let { json, gateway, files: filesMode, dir: rootFlag, noHistory, historyDir } = takeLeadingGlobals(args);
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
    const gatewayAuthPresent = hasGatewayAuth();
    const grokBotAppSession = inspectGrokBotGatewaySession();
    const payload = { resolved, found, candidates, gatewayAuthPresent, grokBotAppSession, note };
    if (json) print(payload);
    else {
      print("resolved: " + (resolved ?? "(none)"));
      print("gateway auth: " + (gatewayAuthPresent ? "present" : "no"));
      if (grokBotAppSession.usable) print("Grok Bot app session: usable");
      else if (grokBotAppSession.present) print("Grok Bot app session: present but unusable: " + grokBotAppSession.error);
      else print("Grok Bot app session: not found");
      print("found:");
      print(found.length ? found.map((p) => "  " + p).join("\n") : "  (none)");
      print("candidates:");
      for (const c of candidates) print("  " + c);
      print(note);
    }
    return;
  }

  if (cmd === "history") {
    const options = args.slice(1);
    // Command-local flags (globals only peel from argv before the command).
    if (hasFlag(options, "--json")) { json = true; jsonErrors = true; }
    const showPath = hasFlag(options, "--path");
    const search = takeFlag(options, "--search");
    const limitRaw = takeFlag(options, "--limit");
    const limit = limitRaw === undefined ? 40 : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StoreError("--limit must be a positive integer");
    if (options.length > 1 || options[0]?.startsWith("-") || (showPath && (options.length || search !== undefined || limitRaw !== undefined))) {
      throw new StoreError("gbot history [bot-or-group] [--search TEXT] [--limit N], or history --path");
    }
    const path = historyPath(historyDir);
    if (showPath) print(json ? { path } : path);
    else {
      const rows = await readHistory(path, { ref: options[0], search, limit });
      if (json) print(rows);
      else print(rows.length ? rows.map((row) =>
        "[" + row.recordedAt + "] " + row.target.name + " (" + row.target.id + ") [" + row.role + "] " + row.text
      ).join("\n") : "No local history.");
    }
    return;
  }

  if (cmd === "codex") {
    await runCodex(sub, rest, json);
    return;
  }

  // Peel command-local --json before touching the backend so auth/gateway
  // failures honor it. Send peels a trailing --json only (mid-text tokens stay
  // message content); `--` protects everything after it.
  if (cmd === "send" && takeTrailingFlag(rest, "--json")) { json = true; jsonErrors = true; }
  if ((cmd === "thread" || cmd === "chat") && hasFlag(rest, "--json")) { json = true; jsonErrors = true; }

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
    // Envelope flags precede the target: `gbot send --reply-to M --hop 1 <bot> <message>`.
    const sendArgs = [sub, ...rest].filter((a) => a !== undefined);
    // Trailing --json is a flag; `--` protects a message that ends with one.
    if (takeTrailingFlag(sendArgs, "--json")) { json = true; jsonErrors = true; }
    const { envelope } = takeEnvelopeFlags(sendArgs);
    const ref = sendArgs.shift();
    if (sendArgs[0] === "--") sendArgs.shift();
    const message = sendArgs.join(" ").trim();
    if (!ref || ref.startsWith("-") || !message) throw new StoreError("gbot send [envelope flags] <bot-or-group> <message...>");
    const out = await backend.send(ref, withEnvelopeHeader(message, envelope));
    saveHistory(out, { dir: historyDir, disabled: noHistory, event: "send", prompt: message });
    // The gateway's message id (when returned) is the delivery receipt; the local envelope id
    // is the correlation handle a reply quotes back with --reply-to.
    const receipt = out.messageId ? " message " + out.messageId : "";
    if (json) {
      print({
        id: out.target.id,
        name: out.target.name,
        kind: out.target.isGroup ? "group" : "bot",
        result: out.result,
        delivery: out.delivery || "accepted",
        ...(out.messageId ? { messageId: out.messageId } : {}),
        envelopeId: envelope.messageId,
        correlationId: envelope.correlationId,
        ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
        hop: envelope.hop,
        maxHops: envelope.maxHops,
      });
    } else print("Sent to " + (out.target.isGroup ? "group" : "bot") + " " + out.target.name + " (" + out.target.id + ")" + receipt + "; envelope " + envelope.messageId);
    return;
  }

  if (cmd === "thread" || cmd === "chat") {
    const ref = sub;
    if (!ref) throw new StoreError("gbot thread <bot-or-group> [--limit N] [--after ENTRY_ID] [--root MESSAGE_ID] [--full]");
    const full = hasFlag(rest, "--full");
    const limitRaw = takeFlag(rest, "--limit");
    const rootId = takeFlag(rest, "--root");
    const after = takeFlag(rest, "--after");
    const limit = limitRaw ? Number(limitRaw) : 40;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new StoreError("--limit must be an integer 1-200");
    if (after !== undefined && (after.length === 0 || after.length > 1024)) throw new StoreError("--after must be 1-1024 characters");
    if (after !== undefined && rootId !== undefined) throw new StoreError("--after cannot be combined with --root");
    const out = rootId ? await backend.thread(ref, rootId) : await backend.transcript(ref, limit);
    let selected = out;
    if (after !== undefined) {
      const delta = transcriptDelta(out.transcript, { after, limit });
      selected = { ...out, transcript: { entries: delta.entries }, cursor: delta.cursor, entryCount: delta.entryCount, gapReset: delta.gapReset };
    }
    saveHistory(selected, { dir: historyDir, disabled: noHistory, event: cmd, rootId });
    if (json) print(selected);
    else {
      const text = formatTranscript(selected, { full });
      print(after === undefined ? text : text + "\n\ncursor: " + selected.cursor + (selected.gapReset ? " (gap reset)" : ""));
    }
    return;
  }

  throw new StoreError(usage());
}

main(process.argv).catch(fail);
