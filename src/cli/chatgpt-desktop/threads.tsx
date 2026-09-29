import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  listThreadsOperation,
  resultSchema,
  resultText,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description: 'List ChatGPT Desktop threads via CDP (app-server fallback when CDP is down).',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      limit: { default: 50, description: 'Max threads (1-200)', type: 'number' },
      port: { description: 'Local CDP port', type: 'number' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();
export { resultSchema };

export default async function chatgptDesktopThreads({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await listThreadsOperation(input);
  const threads = Array.isArray(out.threads) ? out.threads : [];
  const text =
    threads.length > 0
      ? threads
          .map((thread) => {
            const row = thread as {
              threadId?: string;
              title?: string;
              selected?: boolean;
              pinned?: boolean;
            };
            return (
              `${row.selected ? '* ' : '  '}${row.threadId ?? ''}  ${row.title ?? ''}` +
              (row.pinned ? ' (pinned)' : '')
            );
          })
          .join('\n') + `\n\nbackend: ${String(out.backend ?? '')}`
      : resultText(out);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
