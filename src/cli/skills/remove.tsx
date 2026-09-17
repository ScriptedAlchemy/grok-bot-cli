import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';

export const config = {
  description: 'Remove a library skill by id or name. Every bot loses it.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      skill: { description: 'Skill id or name', type: 'string' },
    },
    required: ['skill'],
    type: 'object',
  },
  positionals: ['skill'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ skill: z.string().min(1) }).strict();
export const resultSchema = skillSchema;

export default async function skillsRemove({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const skill = resultSchema.parse(await backend.removeSkill(input.skill));
  return (
    <Agent.Result value={skill}>
      <Agent.Text>{`Removed skill ${skill.name} (${skill.id}) from the shared library`}</Agent.Text>
    </Agent.Result>
  );
}
