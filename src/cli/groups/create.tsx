import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';

import { summarize } from '../../core/format.js';
import {
  agentSummarySchema,
  backendFlagsSchema,
  createFieldsSchema,
  openBackendFromInput,
  toCreateInput,
} from '../_shared.js';
import { z } from 'zod';

export const config = {
  description: 'Create a Grok Bot group.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      avatarColor: { type: 'string' },
      avatarShape: { type: 'string' },
      description: { type: 'string' },
      member: { description: 'Member bot id or name (repeatable)', items: { type: 'string' }, type: 'array' },
      name: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['name', 'member'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.merge(createFieldsSchema).extend({
  member: z.array(z.string().min(1)).min(1),
}).strict();
export const resultSchema = agentSummarySchema;

export default async function groupsCreate({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const { dir: _d, files: _f, gateway: _g, member, ...fields } = input;
  const rec = await backend.createGroup({ ...toCreateInput(fields), memberIds: member });
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{`Created group ${rec.name} (${rec.id}) with ${rec.memberIds.length} members`}</Agent.Text>
    </Agent.Result>
  );
}
