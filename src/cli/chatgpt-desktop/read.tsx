import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  readThreadOperation,
  resultSchema,
  resultText,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description: 'Read a ChatGPT Desktop thread via CDP (app-server fallback when CDP is down).',
  exitCode: 'result',
  positionals: ['threadId'],
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      limit: { default: 100, type: 'number' },
      port: { type: 'number' },
      threadId: { type: 'string' },
    },
    required: ['threadId'],
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).default(100),
    port: z.number().int().min(1).max(65535).optional(),
    threadId: z.string().min(1).max(256),
  })
  .strict();
export { resultSchema };

export default async function chatgptDesktopRead({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await readThreadOperation(input);
  const turns = Array.isArray(out.turns) ? out.turns : [];
  const text =
    turns.length > 0
      ? turns
          .map((turn) => {
            const row = turn as { role?: string; text?: string; turnKey?: string };
            return `[${row.role ?? '?'} ${row.turnKey ?? ''}] ${row.text ?? ''}`;
          })
          .join('\n\n') + `\n\nbackend: ${String(out.backend ?? '')}`
      : resultText(out);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
