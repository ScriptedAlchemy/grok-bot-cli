import { z } from 'zod';
import { sendToClaude } from './claude-channel.js';

export const inputSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/).describe('Explicit name of the live Claude channel.'),
  message: z.string().min(1).max(65536),
  timeoutMs: z.number().int().min(1).max(120000).default(60000),
}).strict();
export const resultSchema = z.object({
  delivery: z.enum(['replied', 'unknown', 'rejected']),
  requestId: z.string().optional(),
  reply: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.union([z.literal(0), z.literal(1)]),
}).strict();
export async function sendOperation(input: z.infer<typeof inputSchema>) {
  try {
    const result = await sendToClaude(input) as Omit<z.infer<typeof resultSchema>, 'exitCode'>;
    return { ...result, exitCode: result.delivery === 'replied' ? 0 as const : 1 as const };
  } catch (error) {
    return { delivery: 'rejected' as const, error: error instanceof Error ? error.message : String(error), exitCode: 1 as const };
  }
}
