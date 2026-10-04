import { hostname } from "node:os";

/**
 * Provenance prefix for messages a Codex thread sends to Grok Bot, so the receiver can answer.
 * Unknown fields are omitted; the thread id is always present when it is known. MCP is the
 * primary reply surface (`codex_send`), the CLI is the fallback.
 */
const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[\]]/g, ")").trim();

export function machineName(env = process.env) {
  try {
    return oneLine(env.GROK_BOT_MACHINE_NAME || hostname());
  } catch {
    return "";
  }
}

/**
 * @param {{ threadId?: string, machine?: string, cwd?: string, details?: string[], env?: NodeJS.ProcessEnv }} fields
 * @returns {string} `[from Codex thread <id> @ <machine>, cwd <cwd>; ...; reply: ...]` or "" without a thread id
 */
export function codexSenderPrefix({ threadId, machine, cwd, details = [], env = process.env } = {}) {
  const id = oneLine(threadId);
  if (!id) return "";
  const where = oneLine(machine ?? machineName(env));
  const dir = oneLine(cwd);
  const head = "from Codex thread " + id + (where ? " @ " + where : "") + (dir ? (where ? ", " : " ") + "cwd " + dir : "");
  const reply = "reply: codex_send({threadId:\"" + id + "\", message:\"...\"})"
    + (where ? " via MCP on " + where : " via MCP")
    + " (or CLI: gbot codex send " + id + " \"...\")";
  return "[" + [head, ...details.map(oneLine).filter(Boolean), reply].join("; ") + "]";
}

/** Prefix + newline + text; the text unchanged when no thread id is known. */
export function withCodexSender(text, fields) {
  const prefix = codexSenderPrefix(fields);
  return prefix ? prefix + "\n" + text : text;
}

/** The Codex terminal exports the current thread id to every command it runs. */
export function envCodexThreadId(env = process.env) {
  const id = env.CODEX_THREAD_ID?.trim();
  return id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : undefined;
}
