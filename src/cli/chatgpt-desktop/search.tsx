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
    'Search ChatGPT Desktop threads via app-server (full provider list); merge CDP selected/pinned.',
  exitCode: 'result',
  positionals: ['query'],
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      limit: { default: 50, description: 'Max matches (1-200)', type: 'number' },
      port: { description: 'Local CDP port', type: 'number' },
      query: { type: 'string' },
    },
    required: ['query'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
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
