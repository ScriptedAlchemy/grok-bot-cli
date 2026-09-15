import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { summarize } from '../../core/format.js';
import { agentSummarySchema, backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: "Replace a group's member list.",
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      group: { type: 'string' },
      member: { description: 'Member bot id or name (repeatable)', items: { type: 'string' }, type: 'array' },
    },
    required: ['group', 'member'],
    type: 'object',
  },
  positionals: ['group'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({
  group: z.string().min(1),
  member: z.array(z.string().min(1)).min(1),
}).strict();
export const resultSchema = agentSummarySchema;

export default async function groupsSet({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const rec = await backend.setGroupMembers(input.group, input.member);
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{`Updated ${rec.name}. Members: ${rec.memberIds.length}`}</Agent.Text>
    </Agent.Result>
  );
}
