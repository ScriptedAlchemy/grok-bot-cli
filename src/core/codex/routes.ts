import { z } from 'zod';
import { buildEnvelope, listCodexThreads, sendToCodexThread } from '../codex-bridge.js';
import { outcomeFromError } from './contract.js';
import { openCodexConversation } from './conversation.js';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const observationFields = {
  expectedCwd: z.string().min(1).optional(),
  threadId: id,
  timeoutMs: z.number().int().min(1).max(600000).optional(),
};
export const sendFields = {
  ...observationFields,
  correlationId: id.optional(), envelope: z.boolean().optional(), hop: z.number().int().min(0).optional(),
  replyTo: id.optional(), expectedTurnId: id.optional(),
  whenBusy: z.enum(['reject', 'queue', 'steer']).default('reject'), wait: z.boolean().default(false),
  maxOutputBytes: z.number().int().min(1).max(4194304).optional(),
};
export const sendSchema = z.object({ ...sendFields, message: z.string().min(1).max(4194304) }).strict();
export const waitSchema = z.object({ ...observationFields, turnId: id, messageId: id.optional(), maxOutputBytes: z.number().int().min(1).max(4194304).optional() }).strict();
export const watchSchema = z.object({ ...observationFields, maxEvents: z.number().int().min(1).max(500).default(100) }).strict();
export const threadsSchema = z.object({ limit: z.number().int().min(1).max(200).default(20), cursor: z.string().min(1).max(4096).optional() }).strict();
export const resultSchema = z.object({
  exitCode: z.number().int().min(0).max(1),
  threadId: z.string().optional(), turnId: z.string().optional(), messageId: z.string().optional(),
  delivery: z.enum(['accepted', 'queued', 'rejected', 'unknown']).optional(),
  execution: z.object({ state: z.enum(['completed', 'failed', 'interrupted', 'waiting-for-input', 'timeout', 'disconnected', 'unknown']), error: z.unknown().optional() }).optional(),
  reply: z.object({ text: z.string().max(4194304), items: z.array(z.object({ id: z.string(), type: z.literal('agentMessage'), phase: z.enum(['final_answer']).nullable(), text: z.string().max(4194304) })).max(2000), truncated: z.boolean() }).optional(),
  interactions: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  events: z.array(z.record(z.string(), z.unknown())).max(500).optional(),
  reason: z.string().optional(), truncated: z.boolean().optional(),
}).passthrough();
type Progress = (message: string) => Promise<void>;

export async function sendOperation(input: z.infer<typeof sendSchema>, signal?: AbortSignal, progress?: Progress, oneShot = false) {
  let envelope;
  let receipt;
  try {
    envelope = buildEnvelope(input);
    if (oneShot && !input.wait && input.whenBusy !== 'steer') {
      return await sendToCodexThread(input.threadId, input.message, { envelope, whenBusy: input.whenBusy, expectedCwd: input.expectedCwd, signal });
    }
    await progress?.('Opening Codex conversation');
    const conversation = await openCodexConversation(input.threadId, { expectedCwd: input.expectedCwd, signal });
    try {
      receipt = await conversation.send(input.message, { envelope, whenBusy: input.whenBusy, expectedTurnId: input.expectedTurnId });
      if (!input.wait || receipt.delivery !== 'accepted' || !receipt.turnId) return receipt;
      await progress?.(`Accepted message ${receipt.messageId}; observing turn ${receipt.turnId}`);
      const result = await conversation.wait({ turnId: receipt.turnId, messageId: receipt.messageId, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes, signal });
      return { ...receipt, execution: result.execution, reply: result.reply, interactions: result.interactions, exitCode: result.execution.state === 'completed' ? 0 : 1 };
    } finally { await conversation.close(); }
  } catch (error) {
    if (receipt?.delivery === 'accepted') return { ...receipt, execution: { state: 'unknown', error: outcomeFromError(error).error }, reply: { text: '', items: [], truncated: true }, interactions: [], exitCode: 1 };
    return { ...outcomeFromError(error), threadId: input.threadId, ...(envelope ? { messageId: envelope.messageId, correlationId: envelope.correlationId, hop: envelope.hop } : {}) };
  }
}
export async function observeOperation(kind: 'wait' | 'watch', input: z.infer<typeof waitSchema> | z.infer<typeof watchSchema>, signal?: AbortSignal, progress?: Progress) {
  try {
    await progress?.(`Observing Codex thread ${input.threadId}`);
    const conversation = await openCodexConversation(input.threadId, { expectedCwd: input.expectedCwd, signal });
    try {
      if (kind === 'wait') {
        const result = await conversation.wait({ ...input as z.infer<typeof waitSchema>, signal });
        return { ...result, exitCode: result.execution.state === 'completed' ? 0 : 1 };
      }
      const result = await conversation.watch({ ...input as z.infer<typeof watchSchema>, signal });
      return { ...result, exitCode: ['timeout', 'event-limit'].includes(result.reason) ? 0 : 1 };
    } finally { await conversation.close(); }
  } catch (error) {
    return { ...outcomeFromError(error), threadId: input.threadId, ...('turnId' in input ? { turnId: input.turnId, messageId: input.messageId } : {}) };
  }
}
export async function threadsOperation(input: z.infer<typeof threadsSchema>) {
  try { return { ...await listCodexThreads(input), exitCode: 0 }; }
  catch (error) { return outcomeFromError(error); }
}
export function resultText(result: Record<string, unknown>) {
  if (result.execution && typeof result.execution === 'object' && 'state' in result.execution) return `Codex turn ${result.turnId}: ${result.execution.state}`;
  if (result.delivery === 'queued') return `Queued ${result.queuedSubmissionId} on busy Codex thread ${result.threadId}; message ${result.messageId}`;
  if (result.error) return String(result.error);
  if (result.delivery === 'accepted') return `Started turn ${result.turnId} (${result.turnStatus}) on Codex thread ${result.threadId}; message ${result.messageId}`;
  if (result.delivery) return `Codex delivery ${result.delivery} on thread ${result.threadId}`;
  if (result.reason) return `Codex observation: ${result.reason}`;
  if (Array.isArray(result.threads)) return `${result.threads.length} Codex threads`;
  return String(result.error ?? 'Codex observation complete');
}
