import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';

export const config = {
  description: 'List the skill library every bot in this Grok Bot shares.',
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
export const resultSchema = z.array(skillSchema);

export default async function skillsList({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const skills = resultSchema.parse(await backend.skills());
  const lines = skills.map((s) => `${s.id}  ${s.name}  [${s.source}]${s.description ? `  ${s.description}` : ''}`);
  return (
    <Agent.Result value={skills}>
      <Agent.Text>{lines.length > 0 ? lines.join('\n') : 'No skills.'}</Agent.Text>
    </Agent.Result>
  );
}
