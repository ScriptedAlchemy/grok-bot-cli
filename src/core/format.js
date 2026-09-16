import { entryText, transcriptEntries } from "./transcript.js";

/** Strip CSI/OSC and other C0/C1 controls so thread fields cannot drive the terminal. */
export function stripTerminalControls(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
}

export function summarize(rec) {
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

export function formatRecord(rec, all) {
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

export function formatTranscript(out, { full = false } = {}) {
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

function truncateCliText(text, max = 400) {
  if (text.length <= max) return text;
  return text.slice(0, max) + "… [+" + (text.length - max) + " chars; --full or --json for complete text]";
}

export function formatCodexStatus(s) {
  const lines = ["socket: " + s.socketPath + " (" + s.socketState + ")"];
  if (!s.reachable) return lines.concat("reachable: no (" + s.mode + ")", s.message).join("\n");
  if (s.mode !== "daemon") {
    return lines.concat("reachable: yes, but unusable (" + s.mode + ")", s.message).join("\n");
  }
  lines.push("reachable: yes (daemon)");
  const cli = s.cliVersion ?? (s.cliVersionProbe === "ok" ? "unknown" : "unknown, probe " + s.cliVersionProbe);
  lines.push(
    "daemon version: " + (s.daemonVersion ?? "unknown")
      + "  cli version: " + cli
      + "  pinned schema: " + s.pinnedVersion + " (" + s.schema.compatibility + ")",
  );
  lines.push(s.desktopAttached === "attached-shim"
    ? "desktop attached: attached-shim (Desktop shim bridges onto the managed daemon)"
    : s.desktopAttached === "private-stdio"
      ? "desktop attached: private-stdio (ChatGPT Desktop runs its own private stdio app-server; start a managed daemon with `codex app-server daemon start`)"
      : "desktop attached: unknown (not observable from the socket)");
  if (s.versionMismatch) {
    lines.push("warning: daemon and CLI versions differ; `codex app-server daemon restart` picks up the installed CLI");
  }
  return lines.join("\n");
}

export function formatCodexQueue({ threadId, queued }) {
  if (queued.length === 0) return "No queued submissions on Codex thread " + threadId + ".";
  return queued
    .map((q) => q.id + "  " + (q.clientUserMessageId ?? "") + "\n    " + stripTerminalControls(q.text).replace(/\s+/g, " ").slice(0, 200))
    .join("\n\n");
}

export function formatCodexThread(t) {
  const title = t.name ? " - " + stripTerminalControls(t.name) : "";
  const preview = t.preview
    ? "\n    " + stripTerminalControls(String(t.preview).replace(/\s+/g, " ")).slice(0, 200)
    : "";
  return stripTerminalControls(t.id) + "  " + stripTerminalControls(t.status) + title
    + "\n    " + stripTerminalControls(t.cwd ?? "") + preview;
}

/** Shell-safe single-quoting for copy-pasteable export lines (spaces, quotes, $). */
export function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

export function formatDesktopShimStatus(s) {
  const mark = (ok) => (ok ? "yes" : "no");
  const cliLine = s.platform === "darwin"
    ? "CODEX_CLI_PATH: GUI domain " + (s.guiCliPath ?? "(unset)") + " / this shell " + (s.cliPath ?? "(unset)")
      + (s.wrapperPointsAtShim ? " (Desktop-facing value points at shim)" : "")
    : "CODEX_CLI_PATH: " + (s.cliPath ?? "(unset)") + (s.wrapperPointsAtShim ? " (points at shim)" : "");
  const lines = [
    "wrapper: " + s.wrapperPath + " (" + (s.wrapperExecutable ? "executable" : s.wrapperPresent ? "present, not executable" : "absent") + ")",
    "bridge: " + s.bridgePath + " (" + mark(s.bridgePresent) + ")",
    "login env: " + s.envScriptPath + " (" + mark(s.envScriptPresent) + ")",
    s.platform === "darwin"
      ? "LaunchAgent: " + s.plistPath + " (" + mark(s.plistPresent) + ")"
      : "LaunchAgent: n/a (macOS-only)",
    cliLine,
    "daemon socket: " + s.socketPath + " (" + s.socketState + ", from " + (s.socketSource ?? "CODEX_HOME") + ")",
  ];
  if (!s.installed) {
    lines.push("shim: not installed — run `gbot codex desktop-shim install` (Desktop keeps stock behavior until then)");
  } else if (!s.wrapperPointsAtShim) {
    lines.push(
      s.platform === "darwin"
        ? "shim: installed but CODEX_CLI_PATH does not point at it — reinstall or relaunch ChatGPT.app after login"
        : "shim: installed but CODEX_CLI_PATH does not point at it — export CODEX_CLI_PATH=" + shellQuote(s.wrapperPath),
    );
  } else {
    lines.push("shim: active — Desktop app-server spawns bridge onto the managed daemon");
  }
  for (const warning of s.warnings ?? []) lines.push("warning: " + String(warning));
  return lines.join("\n");
}
