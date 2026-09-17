import { z } from "zod";
import { redactSecrets } from "./url-policy.js";

const id = z.string().min(1).max(1024);
export const grokApprovalResponseSchema = z.strictObject({
  target: id,
  entryId: id,
  requestId: id,
  decision: z.enum(["accept", "decline"]),
});

export function grokApproval(entry) {
  if (entry?.kind !== "send-message") return null;
  const type = entry.message?.type;
  const card = type === "auto-review-approval" ? entry.message.approval
    : type === "local-tool-permission" ? entry.message.ask : null;
  if (card?.status !== "pending" || !id.safeParse(card.requestId).success || !id.safeParse(entry.id).success) return null;
  const details = {};
  let truncated = false;
  for (const key of ["reason", "command", "summary", "action", "description", "target", "machineId", "surface", "workingDirectory"]) {
    if (typeof card[key] !== "string") continue;
    const text = redactSecrets(card[key]);
    truncated ||= text.length > 2048;
    details[key] = text.slice(0, 2048);
  }
  return { entryId: entry.id, requestId: card.requestId, type, ...details, truncated };
}

export function grokApprovalNotice(entry, target) {
  const approval = grokApproval(entry);
  return approval ? `Grok approval pending. Requires an explicit user decision; never approve automatically.\n${JSON.stringify({ botTarget: target, ...approval })}\nUse gbot_grok_respond with target=${JSON.stringify(target)}, entryId, requestId and decision accept (once) or decline.${approval.truncated ? " Details are truncated; acceptance requires the owning Grok UI." : ""} A chat reply is not authorization.` : null;
}
