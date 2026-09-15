import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { listCodexQueue } from '../../core/codex-bridge.js';
import { outcomeFromError } from '../../core/codex/contract.js';
import { formatCodexQueue } from '../../core/format.js';
import { failureDocumentSchema } from '../_shared.js';

export const config = {
  description: 'List the experimental Codex thread queue (GROK_BOT_CODEX_EXPERIMENTAL=1).',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: { threadId: { type: 'string' } },
    required: ['threadId'],
    type: 'object',
  },
  positionals: ['threadId'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({ threadId: z.string().min(1) }).strict();
export const resultSchema = z.union([
  z.object({
    exitCode: z.literal(0),
    nextCursor: z.string().nullable(),
    queued: z.array(z.object({
      clientUserMessageId: z.string().nullable(),
      id: z.string().nullable(),
      text: z.string(),
    }).strict()),
    threadId: z.string(),
  }).strict(),
  failureDocumentSchema,
]);

export default async function codexQueue({ input }: CliRouteProps<typeof inputSchema>) {
  let out;
  try {
    out = await listCodexQueue(input.threadId);
  } catch (error) {
    const failure = outcomeFromError(error);
    return (
      <Agent.Result value={failure}>
        <Agent.Text>{failure.error}</Agent.Text>
      </Agent.Result>
    );
  }
  return (
    <Agent.Result value={{ ...out, exitCode: 0 as const }}>
      <Agent.Text>{formatCodexQueue(out)}</Agent.Text>
    </Agent.Result>
  );
}
