import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  listThreadsOperation,
  resultSchema,
  resultText,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'List local + remote-control ChatGPT Desktop threads; --host and --model-provider are separate filters.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      groupBy: { description: 'Group results by host', enum: ['host'], type: 'string' },
      host: {
        description: 'Filter: all (default) | local | hostId or friendly name',
        type: 'string',
      },
      limit: { default: 50, description: 'Max threads (1-200)', type: 'number' },
      modelProvider: {
        description: 'Pass-through to app-server modelProviders (omit = all)',
        type: 'string',
      },
      port: { description: 'Local CDP port', type: 'number' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    groupBy: z.literal('host').optional(),
    host: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    modelProvider: z.string().min(1).max(256).optional(),
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
              location?: string;
              hostId?: string | null;
              hostName?: string | null;
              modelProvider?: string | null;
            };
            const where =
              row.location === 'remote'
                ? ` [remote ${row.hostName || row.hostId || '?'}]`
                : ' [local]';
            const provider = row.modelProvider ? ` {${row.modelProvider}}` : '';
            return (
              `${row.selected ? '* ' : '  '}${row.threadId ?? ''}  ${row.title ?? ''}` +
              (row.pinned ? ' (pinned)' : '') +
              where +
              provider
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
