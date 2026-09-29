import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  resultSchema,
  resultText,
  searchThreadsOperation,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'Search ChatGPT Desktop threads. --host and --model-provider accept any string (see gbot chatgpt-desktop hosts); not enums.',
  exitCode: 'result',
  positionals: ['query'],
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      groupBy: {
        description: 'Group results by host (grouping mode, not a host id)',
        enum: ['host'],
        type: 'string',
      },
      host: {
        description:
          'Any string: all (default), local, or a hostId/friendly name from `gbot chatgpt-desktop hosts`. Not an enum.',
        type: 'string',
      },
      limit: { default: 50, description: 'Max matches (1-200)', type: 'number' },
      cursor: { description: 'Opaque nextCursor from a prior search page', type: 'string' },
      modelProvider: {
        description:
          'Any modelProvider id (app-server modelProviders pass-through). Omit = all. See `gbot chatgpt-desktop hosts`. Not an enum.',
        type: 'string',
      },
      project: { description: 'Project label or projectId filter.', type: 'string' },
      port: { description: 'Local CDP port', type: 'number' },
      query: { type: 'string' },
    },
    required: ['query'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    groupBy: z.literal('host').optional(),
    host: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(4096).optional(),
    modelProvider: z.string().min(1).max(256).optional(),
    project: z.string().min(1).max(256).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    query: z.string().min(1).max(512),
  })
  .strict();
export { resultSchema };

export default async function chatgptDesktopSearch({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await searchThreadsOperation(input);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{resultText(out)}</Agent.Text>
    </Agent.Result>
  );
}
