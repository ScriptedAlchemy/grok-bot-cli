import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { summarize } from '../../core/format.js';
import {
  agentSummarySchema,
  backendFlagsSchema,
  openBackendFromInput,
  toUpdatePatch,
  updateFieldsSchema,
} from '../_shared.js';

export const config = {
  description: 'Update a bot or group profile.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      avatarColor: { type: 'string' },
      avatarShape: { type: 'string' },
      description: { type: 'string' },
      hidden: { type: 'string' },
      name: { type: 'string' },
      notify: { type: 'string' },
      ref: { description: 'Bot or group id or name', type: 'string' },
      title: { type: 'string' },
    },
    required: ['ref'],
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.merge(updateFieldsSchema).extend({ ref: z.string().min(1) }).strict();
export const resultSchema = agentSummarySchema;

export default async function botsUpdate({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const { dir: _d, files: _f, gateway: _g, ref, ...fields } = input;
  const rec = await backend.updateAgent(ref, toUpdatePatch(fields));
  return (
    <Agent.Result value={summarize(rec)}>
      <Agent.Text>{`Updated ${rec.isGroup ? 'group' : 'bot'} ${rec.name} (${rec.id})`}</Agent.Text>
    </Agent.Result>
  );
}
