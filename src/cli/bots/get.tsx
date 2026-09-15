import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { formatRecord, summarize } from '../../core/format.js';
import { agentSummarySchema, backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Show one bot or group by id or name.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      ref: { description: 'Bot or group id or name', type: 'string' },
    },
    required: ['ref'],
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ ref: z.string().min(1) }).strict();
export const resultSchema = agentSummarySchema;

export default async function botsGet({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const rec = await backend.resolve(input.ref);
  const all = await backend.list();
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{formatRecord(rec, all)}</Agent.Text>
    </Agent.Result>
  );
}
