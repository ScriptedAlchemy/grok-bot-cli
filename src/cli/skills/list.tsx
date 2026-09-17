import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';

export const config = {
  description: 'List the skills attached to one bot.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      ref: { description: 'Bot id or name', type: 'string' },
    },
    required: ['ref'],
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ ref: z.string().min(1) }).strict();
export const resultSchema = z.array(skillSchema);

export default async function skillsList({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const skills = resultSchema.parse(await backend.skills(input.ref));
  const lines = skills.map((s) => `${s.id}  ${s.name}  [${s.source}]${s.description ? `  ${s.description}` : ''}`);
  return (
    <Agent.Result value={skills}>
      <Agent.Text>{lines.length > 0 ? lines.join('\n') : `No skills on ${input.ref}.`}</Agent.Text>
    </Agent.Result>
  );
}
