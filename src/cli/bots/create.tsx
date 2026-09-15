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

export const config = {
  description: 'Create a Grok Bot bot.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      avatarColor: { type: 'string' },
      avatarShape: { type: 'string' },
      description: { type: 'string' },
      name: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['name'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.merge(createFieldsSchema).strict();
export const resultSchema = agentSummarySchema;

export default async function botsCreate({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const { dir: _d, files: _f, gateway: _g, ...fields } = input;
  const rec = await backend.createAgent(toCreateInput(fields));
  if (rec == null) throw new Error('createAgent returned no record');
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{`Created bot ${rec.name} (${rec.id})`}</Agent.Text>
    </Agent.Result>
  );
}
