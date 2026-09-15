import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { historyPath, readHistory } from '../core/history.js';

export const config = {
  description: 'Read the opt-in local JSONL history without contacting the gateway.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      historyDir: { description: 'Directory containing history.jsonl', type: 'string' },
      limit: { default: 40, description: 'Maximum matching rows (1 or more)', type: 'number' },
      path: { description: 'Print the history file path', type: 'boolean' },
      ref: { description: 'Bot or group id or name', type: 'string' },
      search: { description: 'Case-insensitive message text filter', type: 'string' },
    },
    type: 'object',
  },
  positionals: ['ref'],
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    historyDir: z.string().min(1).optional(),
    limit: z.number().int().min(1).default(40),
    path: z.boolean().default(false),
    ref: z.string().min(1).optional(),
    search: z.string().optional(),
  })
  .strict()
  .refine(
    (input) => !input.path || (input.ref === undefined && input.search === undefined && input.limit === 40),
    '--path cannot be combined with a target, --search, or --limit',
  );

const historyRowSchema = z.record(z.string(), z.json());
export const resultSchema = z.union([
  z.array(historyRowSchema),
  z.object({ path: z.string() }).strict(),
]);

export default async function history({ input }: CliRouteProps<typeof inputSchema>) {
  const file = historyPath(input.historyDir);
  if (input.path) {
    return (
      <Agent.Result value={{ path: file }}>
        <Agent.Text>{file}</Agent.Text>
      </Agent.Result>
    );
  }
  const rows = await readHistory(file, {
    limit: input.limit,
    ref: input.ref,
    search: input.search,
  });
  const text = rows.length
    ? rows
        .map(
          (row: {
            readonly recordedAt: string;
            readonly role: string;
            readonly target: { readonly id: string; readonly name: string };
            readonly text: string;
          }) =>
            `[${row.recordedAt}] ${row.target.name} (${row.target.id}) [${row.role}] ${row.text}`,
        )
        .join('\n')
    : 'No local history.';
  return (
    <Agent.Result value={rows}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
