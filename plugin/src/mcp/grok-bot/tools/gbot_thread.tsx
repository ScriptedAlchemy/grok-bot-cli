import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import {
  connectGateway,
  entrySchema,
  getTranscriptTail,
  summarizeTarget,
  targetSchema,
  threadCursor,
  transcriptEntries,
  withRedactedErrors,
} from '../../../gbot.js';

export default defineTool(
  {
    annotations: { readOnlyHint: true },
    description:
      'Read the most recent messages in a Grok Bot bot or group thread, like `gbot thread`. By default returns a short summary plus a cursor and withholds entry text; pass full:true to read the text. Use it to collect the reply to a gbot_send.',
    inputJsonSchema: {
      additionalProperties: false,
      properties: {
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
    inputSchema: z.object({
      // ponytail: the route inputJsonSchema type cannot express minimum/maximum, so the
      // 1-200 bound lives here in zod (and in the CLI/gateway); widen the route type to align them.
      limit: z.number().int().min(1).max(200).default(40),
      full: z.boolean().default(false),
      target: z.string().min(1),
    }),
    resultSchema: z.object({ cursor: z.string(), entries: z.array(entrySchema).optional(), target: targetSchema }),
    title: 'Read a Grok Bot thread',
  },
  async ({ limit, target, full }) => {
    const tail = await withRedactedErrors(async () => getTranscriptTail(await connectGateway(), target, limit));
    const entries = transcriptEntries(tail.transcript, { full, limit });
    const cursor = threadCursor(tail.transcript, entries.length);
    const summarized = summarizeTarget(tail.target);
    const summary = `${summarized.kind} ${summarized.name}: ${entries.length} entries.`;
    // Keep both model-facing channels small by omitting entries from the default
    // structured value as well as withholding per-entry Agent.Text.
    if (!full) {
      const value = { cursor, target: summarized };
      return (
        <Agent.Result value={value}>
          <Agent.Text>{`${summary} Cursor returned separately; entry text withheld; pass full:true to read it.`}</Agent.Text>
        </Agent.Result>
      );
    }
    const value = { cursor, entries, target: summarized };
    return (
      <Agent.Result value={value}>
        <Agent.Text>{summary}</Agent.Text>
        {entries.map((entry, index) => (
          <Agent.Text key={entry.id || index}>{`[${entry.role ?? entry.kind}] ${entry.text}`}</Agent.Text>
        ))}
      </Agent.Result>
    );
  },
);
