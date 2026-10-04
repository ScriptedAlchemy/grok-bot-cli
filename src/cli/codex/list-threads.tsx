import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { listCodexThreads, singleLine } from '../../core/codex-bridge.js';
import { outcomeFromError } from '../../core/codex/contract.js';
import { formatCodexThread } from '../../core/format.js';
import { failureDocumentSchema } from '../_shared.js';
import { threadsSchema } from '../../core/codex/routes.js';

export const config = {
  description:
    'List Codex daemon-managed threads, newest activity first (all modelProviders; pages via --cursor / nextCursor). Find old threads with --query (name/title/id prefix, all pages), --active-within 7d, --since, --sort created.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      cursor: {
        description: 'Opaque pagination cursor from a previous nextCursor (may start with -)',
        type: 'string',
      },
      limit: { default: 20, description: 'Max threads to list (1-200)', type: 'number' },
      sort: { default: 'updated', description: 'updated (last activity, default) | created | recency', enum: ['updated', 'created', 'recency'], type: 'string' },
      order: { default: 'desc', enum: ['desc', 'asc'], type: 'string' },
      query: { description: 'Case-insensitive substring of name/title, preview or id (id prefix works); scans every page', type: 'string' },
      activeWithin: { description: 'Only threads updated within 90s, 30m, 12h, 7d, 2w', type: 'string' },
      since: { description: 'Only threads updated at/after this ISO date/time or epoch seconds', type: 'string' },
      cwd: { description: 'Exact session cwd', type: 'string' },
      modelProvider: { description: 'Any modelProvider id; omit for all', type: 'string' },
      sourceKind: { description: 'Any app-server source kind; omit for interactive sources', type: 'string' },
      archived: { description: 'Archived threads only', type: 'boolean' },
    },
    type: 'object',
  },
} satisfies CliRouteConfig;

export const inputSchema = threadsSchema;
export const resultSchema = z.union([
  z.object({
    exitCode: z.literal(0),
    limit: z.number().int().min(1).max(200),
    sort: z.string().optional(),
    order: z.string().optional(),
    scanned: z.number().int().min(0).optional(),
    nextCursor: z.string().nullable(),
    threads: z.array(z.record(z.string(), z.json())),
    useStateDbOnly: z.boolean().optional(),
  }).strict(),
  failureDocumentSchema,
]);

export default async function codexListThreads({ input }: CliRouteProps<typeof inputSchema>) {
  let out;
  try {
    const { sourceKind, ...rest } = input;
    out = await listCodexThreads({ ...rest, ...(sourceKind ? { sourceKinds: [sourceKind] } : {}) });
  } catch (error) {
    const failure = outcomeFromError(error);
    return (
      <Agent.Result value={failure}>
        <Agent.Text>{failure.error}</Agent.Text>
      </Agent.Result>
    );
  }
  const more = out.nextCursor
    ? `\n\nmore: --cursor ${JSON.stringify(singleLine(out.nextCursor))}`
    : '';
  const text = out.threads.length === 0
    ? 'No Codex threads.'
    : out.threads.map(formatCodexThread).join('\n\n') + more;
  return (
    <Agent.Result value={{ ...out, exitCode: 0 as const }}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
