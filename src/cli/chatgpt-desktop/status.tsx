import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  resultSchema,
  resultText,
  statusOperation,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'Probe local ChatGPT Desktop CDP on 127.0.0.1 and report app-server availability for list/deep-read.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      port: { description: 'Local CDP port (default 9222)', type: 'number' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export { resultSchema };

export default async function chatgptDesktopStatus({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await statusOperation(input);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{resultText(out)}</Agent.Text>
    </Agent.Result>
  );
}
