import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import {
  connectGateway,
  entrySchema,
  getTranscriptTail,
  RECEIPT_CURSOR_MAX,
  transcriptDelta,
  transcriptEntries,
  withRedactedErrors,
} from '../../../gbot.js';

export const inputSchema = z.object({
  // ponytail: the route inputJsonSchema type cannot express minimum/maximum, so the
  // 1-200 bound lives here in zod (and in the CLI/gateway); widen the route type to align them.
  after: z.string().min(1).max(RECEIPT_CURSOR_MAX).optional(),
  limit: z.number().int().min(1).max(200).default(40),
  full: z.boolean().default(false),
  target: z.string().min(1),
});

export default defineTool(
  {
    annotations: { readOnlyHint: true },
    description:
      'Read a bounded Grok Bot thread tail. Returns a small receipt by default; pass the last cursor as after for an exclusive client-side delta, or full:true to include bounded entry text.',
    inputJsonSchema: {
      additionalProperties: false,
      properties: {
        after: {
          description: 'Opaque cursor from the previous call. Returns entries strictly after it; an unknown cursor resets with a bounded snapshot.',
          type: 'string',
        },
        limit: {
          default: 40,
          description: 'How many trailing entries to inspect (1-200). Entries are returned only with full:true.',
          type: 'number',
        },
        full: {
          default: false,
          description:
            'Return entries with text up to bounded budgets (20k chars per entry, 200k total). Every entry reports truncated/fullLength; read any remainder with `gbot thread --full` / `--json` on the machine.',
          type: 'boolean',
        },
        target: { description: 'Bot or group name or id, for example "General".', type: 'string' },
      },
      required: ['target'],
      type: 'object',
    },
    inputSchema,
    resultSchema: z.object({
      cursor: z.string().max(RECEIPT_CURSOR_MAX),
      entries: z.array(entrySchema).optional(),
      entryCount: z.number().int().min(0).max(200),
      gapReset: z.boolean(),
      summary: z.string().max(256),
    }),
    title: 'Read a Grok Bot thread',
  },
  async ({ after, limit, target, full }) => {
    const tail = await withRedactedErrors(async () => getTranscriptTail(await connectGateway(), target, limit));
    const delta = transcriptDelta(tail.transcript, { after, limit });
    const entries = transcriptEntries(delta.entries);
    const summary = delta.gapReset
      ? `${delta.entryCount} entries; gap reset`
      : after === undefined
        ? `${delta.entryCount} entries`
        : `${delta.entryCount} new`;
    const receipt = {
      cursor: delta.cursor,
      entryCount: delta.entryCount,
      gapReset: delta.gapReset,
      summary,
    };
    if (!full) {
      return (
        <Agent.Result value={receipt}>
          <Agent.Text>{summary}</Agent.Text>
        </Agent.Result>
      );
    }
    const value = { ...receipt, entries };
    return (
      <Agent.Result value={value}>
        <Agent.Text>{summary}</Agent.Text>
      </Agent.Result>
    );
  },
);
