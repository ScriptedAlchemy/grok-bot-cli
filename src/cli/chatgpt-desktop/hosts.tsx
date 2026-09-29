import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import {
  listHostsOperation,
  resultSchema,
  resultText,
} from '../../core/chatgpt-desktop/routes.js';

export const config = {
  description:
    'List discovered ChatGPT Desktop hosts (local + remote-thread-summaries-v3) with thread counts, friendly names, and modelProviders.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      port: { description: 'Local CDP port', type: 'number' },
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

export default async function chatgptDesktopHosts({
  input,
}: CliRouteProps<typeof inputSchema>) {
  const out = await listHostsOperation(input);
  const hosts = Array.isArray(out.hosts) ? out.hosts : [];
  const text =
    hosts.length > 0
      ? hosts
          .map((host) => {
            const row = host as {
              hostId?: string;
              hostName?: string | null;
              location?: string;
              threadCount?: number;
            };
            const name =
              row.hostName && row.hostName !== row.hostId ? ` (${row.hostName})` : '';
            return `${row.hostId ?? '?'}${name}  [${row.location ?? '?'}]  threads=${row.threadCount ?? 0}`;
          })
          .join('\n') +
        `\n\nhostsSource: ${String(out.hostsSource ?? '')}` +
        `\nmodelProviders: ${JSON.stringify(out.modelProviders ?? [])}` +
        `\nmodelProvidersSource: ${String(out.modelProvidersSource ?? '')}`
      : resultText(out);
  return (
    <Agent.Result value={out}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
