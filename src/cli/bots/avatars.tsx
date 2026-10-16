import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { backendFlagsSchema, openBackendFromInput } from '../_shared.js';

const EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

export const config = {
  description: 'Write custom bot and group avatars to a directory.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      outDir: { description: 'Directory to write <id>.<ext> avatar files into', type: 'string' },
    },
    required: ['outDir'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema.extend({ outDir: z.string().min(1) }).strict();
export const resultSchema = z.array(z.object({
  bytes: z.number(),
  file: z.string(),
  id: z.string(),
  mimeType: z.string(),
}).strict());

export default async function botsAvatars({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  const all = await backend.list();
  mkdirSync(input.outDir, { recursive: true });
  const written = [];
  for (const rec of all as Array<{ id: string; avatarDataUrl?: string }>) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(rec.avatarDataUrl ?? '');
    if (!match) continue;
    const mimeType = match[1].toLowerCase();
    const extension = EXTENSIONS[mimeType];
    if (!extension) continue;
    const data = Buffer.from(match[2], 'base64');
    const file = join(input.outDir, `${rec.id}.${extension}`);
    writeFileSync(file, data);
    written.push({ bytes: data.length, file, id: rec.id, mimeType });
  }
  return (
    <Agent.Result value={written}>
      <Agent.Text>{written.length === 0 ? 'No custom avatars.' : written.map((w) => `${w.id} ${w.file}`).join('\n')}</Agent.Text>
    </Agent.Result>
  );
}
