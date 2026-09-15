import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { summarize } from '../../core/format.js';
import { agentSummarySchema, backendFlagsSchema, openBackendFromInput } from '../_shared.js';

export const config = {
  description: 'Add a bot to a group.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      bot: { type: 'string' },
      group: { type: 'string' },
    },
    required: ['group', 'bot'],
    type: 'object',
  },
  positionals: ['group', 'bot'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({
  bot: z.string().min(1),
  group: z.string().min(1),
}).strict();
export const resultSchema = agentSummarySchema;

export default async function groupsAdd({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const rec = await backend.addGroupMember(input.group, input.bot);
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{`Added to ${rec.name}. Members: ${rec.memberIds.length}`}</Agent.Text>
    </Agent.Result>
  );
}
