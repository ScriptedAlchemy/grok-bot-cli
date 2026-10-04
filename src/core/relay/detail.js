/** One-line, bounded, control-free text for why a relay delivery or turn failed (<= 1024 chars, the record limit). */
export function errorDetail(value) {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 1024) : undefined;
}
