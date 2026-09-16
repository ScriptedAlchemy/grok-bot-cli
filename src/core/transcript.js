/** Coerce anything to a string without throwing (numbers, BigInt, unserializable objects). */
function toSafeText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : "";
  } catch {
    return "[unserializable]";
  }
}

/** Coerce to string and replace lone surrogates so downstream slicing/JSON never breaks. */
function normalizeText(value) {
  return toSafeText(value).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

export function entryText(e) {
  return normalizeText(entryTextRaw(e));
}

function entryTextRaw(e) {
  if (!e || typeof e !== "object") return "";
  // Prefer full body fields over `preview` (often truncated for list UIs).
  const direct = e.text || e.prompt || e.message;
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
  if (content && typeof content === "object") return content.text || toSafeText(content);
  // Bot replies arrive as `{ kind: "send-message", message: { type, content } }`.
  if (e.message && typeof e.message === "object" && typeof e.message.content === "string") return e.message.content;
  return typeof e.preview === "string" ? e.preview : "";
}

export function transcriptEntries(payload) {
  if (!payload || typeof payload !== "object") return [];
  return Array.isArray(payload.entries) ? payload.entries : [];
}

export function sourceEntryId(entry) {
  if (!entry || typeof entry !== "object") return "";
  return typeof entry.id === "string" ? entry.id : "";
}

function lastSourceId(entries, fallback = "") {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = sourceEntryId(entries[index]);
    if (id) return id;
  }
  return fallback;
}

export function transcriptDelta(payload, { after, limit = 40 } = /** @type {{ after?: string, limit?: number }} */ ({})) {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const page = transcriptEntries(payload).slice(-bounded);
  if (after === undefined) {
    const gapReset = page.length > 0 && !sourceEntryId(page[page.length - 1]);
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset };
  }
  const afterIndex = page.findIndex((entry) => sourceEntryId(entry) === after);
  if (afterIndex === -1) {
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset: true };
  }
  const entries = page.slice(afterIndex + 1);
  if (entries.length > 0 && !sourceEntryId(entries[entries.length - 1])) {
    return { cursor: lastSourceId(page), entries: page, entryCount: page.length, gapReset: true };
  }
  return { cursor: lastSourceId(entries, after), entries, entryCount: entries.length, gapReset: false };
}
