import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { agentSummarySchema, backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';
import { summarize } from '../../core/format.js';

export const config = {
  description: 'Detach a user skill from one bot by id or name.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      ref: { description: 'Bot id or name', type: 'string' },
      skill: { description: 'Skill id or name', type: 'string' },
    },
    required: ['ref', 'skill'],
    type: 'object',
  },
  positionals: ['ref', 'skill'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ ref: z.string().min(1), skill: z.string().min(1) }).strict();
export const resultSchema = z.object({ bot: agentSummarySchema, skill: skillSchema }).strict();

export default async function skillsRemove({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const { bot, skill } = await backend.removeSkill(input.ref, input.skill);
  return (
    <Agent.Result value={{ bot: summarize(bot), skill }}>
      <Agent.Text>{`Detached skill ${skill.name} (${skill.id}) from ${bot.name} (${bot.id})`}</Agent.Text>
    </Agent.Result>
  );
}
