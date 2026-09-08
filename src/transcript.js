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

const TEXT_CARRIERS = ["text", "prompt", "message", "preview", "content"];

function evidenceText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => evidenceText(part)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";

  const candidates = TEXT_CARRIERS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => evidenceText(value[key]))
    .filter(Boolean);
  if (new Set(candidates).size > 1) {
    throw new Error("Conflicting transcript text evidence.");
  }
  return candidates[0] ?? "";
}

function normalizedEntryText(entry) {
  return evidenceText(entry);
}

function normalizedMessageId(entry) {
  const candidates = [];
  for (const key of ["id", "messageId"]) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    const value = entry[key];
    if (value !== null && !isNonblankString(value)) {
      throw new Error("Invalid transcript message id.");
    }
    if (value !== null) candidates.push(value);
  }
  if (new Set(candidates).size > 1) {
    throw new Error("Invalid transcript message id.");
  }
  return candidates[0] ?? null;
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
    return {
      id: normalizedMessageId(entry),
      role: explicitRole(entry),
      text: normalizedEntryText(entry),
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
