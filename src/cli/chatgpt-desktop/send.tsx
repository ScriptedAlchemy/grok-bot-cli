import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  resultSchema,
  resultText,
  sendOperation,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'Send to ChatGPT Desktop via CDP composer. Omit --thread-id for a new chat; --project prefers Start new chat in <project>.',
  exitCode: 'result',
  positionals: ['text'],
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      openTimeoutMs: { type: 'number' },
      port: { type: 'number' },
      project: { type: 'string' },
      text: { type: 'array', items: { type: 'string' } },
      threadId: { type: 'string' },
      unarchive: { type: 'boolean', description: 'Explicitly unarchive an existing archived thread before sending.' },
    },
    required: ['text'],
    type: 'object',
  },
  render: { maxElapsedMs: 660000 },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    openTimeoutMs: z.number().int().min(1).max(600_000).default(90_000),
    port: z.number().int().min(1).max(65535).optional(),
    project: z.string().min(1).max(256).optional(),
    text: z.array(z.string()).min(1),
    threadId: z.string().min(1).max(256).optional(),
    unarchive: z.boolean().default(false),
  })
  .strict();
export { resultSchema };

export default async function chatgptDesktopSend({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await sendOperation({
    port: input.port,
    threadId: input.threadId,
    text: input.text.join(' ').trim(),
    project: input.project,
    unarchive: input.unarchive,
    openTimeoutMs: input.openTimeoutMs,
  });
  return (
    <Agent.Result value={out}>
      <Agent.Text>{resultText(out)}</Agent.Text>
    </Agent.Result>
  );
}
