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
