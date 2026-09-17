import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput, skillSchema } from '../_shared.js';

export const config = {
  description: 'Add a SKILL.md to the shared skill library. Every bot sees it.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      path: { description: 'SKILL.md file, or a directory holding one', type: 'string' },
    },
    required: ['path'],
    type: 'object',
  },
  positionals: ['path'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ path: z.string().min(1) }).strict();
export const resultSchema = skillSchema;

const skillFile = async (path: string): Promise<string> => {
  const target = resolve(path);
  return (await stat(target)).isDirectory() ? join(target, 'SKILL.md') : target;
};

export default async function skillsAdd({ input }: CliRouteProps<typeof inputSchema>) {
  const markdown = await readFile(await skillFile(input.path), 'utf8');
  const backend = await openBackendFromInput(input);
  const skill = resultSchema.parse(await backend.addSkill(markdown));
  return (
    <Agent.Result value={skill}>
      <Agent.Text>{`Added skill ${skill.name} (${skill.id}) to the shared library`}</Agent.Text>
    </Agent.Result>
  );
}
