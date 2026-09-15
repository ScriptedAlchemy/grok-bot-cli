import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { listCodexQueue } from '../../core/codex-bridge.js';

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
export const resultSchema = z.object({
  exitCode: z.literal(0),
  nextCursor: z.string().nullable(),
  queued: z.array(z.object({
    clientUserMessageId: z.string().nullable(),
    id: z.string().nullable(),
    text: z.string(),
  }).strict()),
  threadId: z.string(),
}).strict();

export default async function codexQueue({ input }: CliRouteProps<typeof inputSchema>) {
  const out = await listCodexQueue(input.threadId);
  const value = { ...out, exitCode: 0 as const };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{JSON.stringify(out, null, 2)}</Agent.Text>
    </Agent.Result>
  );
}
