// Shared by `gbot thread` and the grok-bot plugin's gbot_thread tool.

export function entryText(e) {
  if (!e || typeof e !== "object") return "";
  const direct = e.text || e.prompt || e.message || e.preview;
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
  if (content && typeof content === "object") return content.text || JSON.stringify(content);
  // Bot replies arrive as `{ kind: "send-message", message: { type, content } }`.
  if (e.message && typeof e.message === "object" && typeof e.message.content === "string") return e.message.content;
  return "";
}

export function transcriptEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const entries = payload.entries || payload.messages || payload.items;
  return Array.isArray(entries) ? entries : [];
}
