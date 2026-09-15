// Shared by `gbot thread` and the grok-bot plugin's gbot_thread tool.

/** Coerce anything to a string without throwing (numbers, BigInt, unserializable objects). */
export function toSafeText(value) {
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
export function normalizeText(value) {
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
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const entries = payload.entries || payload.messages || payload.items;
  return Array.isArray(entries) ? entries : [];
}
