import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  readThreadOperation,
  resultSchema,
  resultText,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'Read a ChatGPT Desktop thread via app-server (turns/list); CDP DOM is fallback only.',
  exitCode: 'result',
  positionals: ['threadId'],
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      full: { default: false, type: 'boolean' },
      limit: { default: 100, type: 'number' },
      openTimeoutMs: { default: 90000, type: 'number' },
      port: { type: 'number' },
      threadId: { type: 'string' },
    },
    required: ['threadId'],
    type: 'object',
  },
  render: { maxElapsedMs: 660000 },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    full: z.boolean().default(false),
    limit: z.number().int().min(1).max(2000).default(100),
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
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
            const row = turn as {
              role?: string;
              text?: string;
              turnKey?: string;
              userText?: string;
              assistantText?: string;
            };
            const body =
              row.userText || row.assistantText
                ? [
                    row.userText ? `user: ${row.userText}` : null,
                    row.assistantText ? `assistant: ${row.assistantText}` : null,
                  ]
                    .filter(Boolean)
                    .join('\n')
                : row.text ?? '';
            return `[${row.role ?? '?'} ${row.turnKey ?? ''}]\n${body}`;
          })
          .join('\n\n') + `\n\nbackend: ${String(out.backend ?? '')} full: ${String(out.full ?? false)}`
      : resultText(out);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
