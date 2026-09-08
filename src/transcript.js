function contentText(value, { stringifyObject = false } = {}) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => contentText(part)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string" && value.text) return value.text;
  if (value.content != null) {
    const nested = contentText(value.content, { stringifyObject });
    if (nested) return nested;
  }
  return stringifyObject ? JSON.stringify(value) : "";
}

export function entryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  for (const direct of [entry.text, entry.prompt, entry.message, entry.preview]) {
    const text = contentText(direct);
    if (text) return text;
  }
  return contentText(entry.content, { stringifyObject: true });
}

function transcriptEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid transcript container.");
  }
  for (const key of ["entries", "messages", "items"]) {
    if (!(key in payload)) continue;
    if (!Array.isArray(payload[key])) throw new Error("Invalid transcript container.");
    return payload[key];
  }
  throw new Error("Invalid transcript container.");
}

function explicitRole(entry) {
  const nested = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
    ? entry.message
    : null;
  const candidates = [nested?.type, nested?.role, entry.role, entry.kind, entry.type];
  const roles = new Set();
  for (const candidate of candidates) {
    if (candidate === "user" || candidate === "assistant") roles.add(candidate);
  }
  return roles.size === 1 ? roles.values().next().value : "unknown";
}

function isNonblankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeTranscript(out) {
  if (!out || typeof out !== "object" || Array.isArray(out)) {
    throw new Error("Invalid transcript response.");
  }
  const target = out.target;
  if (
    !target
    || typeof target !== "object"
    || Array.isArray(target)
    || !isNonblankString(target.id)
    || !isNonblankString(target.name)
    || typeof target.isGroup !== "boolean"
  ) {
    throw new Error("Invalid transcript target.");
  }

  const hasTranscript = Object.prototype.hasOwnProperty.call(out, "transcript");
  const hasThread = Object.prototype.hasOwnProperty.call(out, "thread");
  const payload = hasTranscript ? out.transcript : hasThread ? out.thread : undefined;
  const entries = transcriptEntries(payload);
  const messages = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid transcript entry.");
    }
    const rawId = entry.id ?? entry.messageId ?? null;
    if (rawId !== null && !isNonblankString(rawId)) {
      throw new Error("Invalid transcript message id.");
    }
    return {
      id: rawId,
      role: explicitRole(entry),
      text: entryText(entry),
    };
  });

  return {
    target: {
      id: target.id,
      name: target.name,
      kind: target.isGroup ? "group" : "bot",
    },
    messages,
  };
}
