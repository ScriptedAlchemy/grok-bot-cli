import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { agentSummarySchema, backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';
import { summarize } from '../../core/format.js';

export const config = {
  description: 'Attach a SKILL.md to one bot. Other bots are not changed.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      name: { description: 'Skill name when the markdown has no frontmatter name', type: 'string' },
      path: { description: 'SKILL.md file, or a directory holding one', type: 'string' },
      ref: { description: 'Bot id or name', type: 'string' },
    },
    required: ['ref', 'path'],
    type: 'object',
  },
  positionals: ['ref', 'path'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema
  .extend({ name: z.string().min(1).optional(), path: z.string().min(1), ref: z.string().min(1) })
  .strict();
export const resultSchema = z.object({ bot: agentSummarySchema, skill: skillSchema }).strict();

const skillFile = async (path: string): Promise<string> => {
  const target = resolve(path);
  return (await stat(target)).isDirectory() ? join(target, 'SKILL.md') : target;
};

export default async function skillsAdd({ input }: CliRouteProps<typeof inputSchema>) {
  const file = await skillFile(input.path);
  const markdown = await readFile(file, 'utf8');
  const backend = await openBackendFromInput(input);
  const { bot, skill } = await backend.addSkill(input.ref, markdown, input.name ?? basename(dirname(file)));
  return (
    <Agent.Result value={{ bot: summarize(bot), skill }}>
      <Agent.Text>{`Attached skill ${skill.name} (${skill.id}) to ${bot.name} (${bot.id})`}</Agent.Text>
    </Agent.Result>
  );
}
