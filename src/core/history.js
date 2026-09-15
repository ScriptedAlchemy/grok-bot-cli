import { appendFileSync, closeSync, constants, createReadStream, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { entryText, transcriptEntries } from "./transcript.js";

export function historyPath(dir) {
  return join(resolve(dir || process.env.GROK_BOT_HISTORY_DIR || join(homedir(), ".grok-bot-cli")), "history.jsonl");
}

// Keep only conversation fields, never gateway responses, session credentials or bot instructions.
export function saveHistory(out, { dir, disabled, event, prompt, rootId } = {}) {
  // Opt-in only: plaintext local history stays off unless GROK_BOT_HISTORY=on (or true/1).
  if (disabled || !/^(on|true|1)$/i.test(process.env.GROK_BOT_HISTORY || "")) return;
  try {
    const recordedAt = new Date().toISOString();
    const target = { id: out.target.id, name: out.target.name, kind: out.target.isGroup ? "group" : "bot" };
    const payload = out.transcript || out.thread || out;
    const entries = event === "send" ? [{ role: "user", text: prompt }] : transcriptEntries(payload);
    const rows = entries.map((entry) => ({
      version: 1,
      recordedAt,
      event,
      target,
      ...(rootId ? { rootId } : {}),
      role: String(entry.role || entry.kind || entry.sender || entry.type || "msg"),
      ...(entry.id || entry.messageId ? { messageId: String(entry.id || entry.messageId) } : {}),
      ...(entry.timestamp || entry.createdAt ? { timestamp: String(entry.timestamp || entry.createdAt) } : {}),
      text: entryText(entry),
    }));
    if (!rows.length) return;
    const path = historyPath(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      // Separate a previous interrupted append from the next complete record.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      if (size) readSync(fd, last, 0, 1, size - 1);
      const prefix = size && last[0] !== 10 ? "\n" : "";
      appendFileSync(fd, prefix + rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    // A successful remote send must not look failed and invite an accidental resend.
    process.stderr.write("Warning: could not save local history. Check the history directory and permissions.\n");
  }
}

/**
 * @param {string} path
 * @param {{ ref?: string, search?: string, limit?: number }} [options]
 */
export async function readHistory(path, { ref, search, limit = 40 } = {}) {
  const rows = [];
  let malformed = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
        if (row?.version !== 1 || typeof row.text !== "string" || typeof row.role !== "string" ||
            typeof row.recordedAt !== "string" || typeof row.target?.id !== "string" || typeof row.target?.name !== "string") {
          throw new Error("Invalid history record");
        }
      } catch {
        malformed++;
        continue;
      }
      if (ref && row.target.id !== ref && row.target.name.toLowerCase() !== ref.toLowerCase()) continue;
      if (search !== undefined && !row.text.toLowerCase().includes(search.toLowerCase())) continue;
      rows.push(row);
      if (rows.length > limit) rows.shift();
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  } finally {
    lines.close();
    input.destroy();
  }
  if (malformed) process.stderr.write("Warning: skipped " + malformed + " malformed local history record(s).\n");
  return rows;
}
