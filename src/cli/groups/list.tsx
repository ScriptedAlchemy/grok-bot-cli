import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { formatRecord, summarize } from '../../core/format.js';
import { agentSummarySchema, backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'List Grok Bot groups.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema;
export const resultSchema = z.array(agentSummarySchema);

export default async function groupsList({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const all = await backend.list();
  const rows = all.filter((r: { isGroup?: boolean }) => r.isGroup);
  const groups = rows.map(summarize);
  const text = rows.length === 0 ? 'No groups.' : rows.map((r: Parameters<typeof formatRecord>[0]) => formatRecord(r, all)).join('\n\n');
  return (
    <Agent.Result value={groups}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
