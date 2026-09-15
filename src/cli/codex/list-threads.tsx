import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { listCodexThreads, singleLine } from '../../core/codex-bridge.js';
import { formatCodexThread } from '../../core/format.js';

export const config = {
  description: 'List Codex daemon-managed threads.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      cursor: {
        description: 'Opaque pagination cursor (may start with -)',
        type: 'string',
      },
      limit: { default: 20, description: 'Max threads to list (1-200)', type: 'number' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(20),
}).strict();
export const resultSchema = z.object({
  exitCode: z.literal(0),
  limit: z.number().int().min(1).max(200),
  nextCursor: z.string().nullable(),
  threads: z.array(z.record(z.string(), z.json())),
}).strict();

export default async function codexListThreads({ input }: CliRouteProps<typeof inputSchema>) {
  const out = await listCodexThreads({ cursor: input.cursor, limit: input.limit });
  const value = { ...out, exitCode: 0 as const };
  const more = out.nextCursor
    ? `\n\nmore: --cursor ${JSON.stringify(singleLine(out.nextCursor))}`
    : '';
  const text = out.threads.length === 0
    ? 'No Codex threads.'
    : out.threads.map(formatCodexThread).join('\n\n') + more;
  return (
    <Agent.Result value={value}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
