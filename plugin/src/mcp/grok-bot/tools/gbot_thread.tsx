import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import {
  connectGateway,
  entrySchema,
  getTranscriptTail,
  summarizeTarget,
  targetSchema,
  transcriptEntries,
  withRedactedErrors,
} from '../../../gbot.js';

export default defineTool(
  {
    annotations: { readOnlyHint: true },
    description:
      'Read the most recent messages in a Grok Bot bot or group thread, like `gbot thread`. Use it to collect the reply to a gbot_send.',
    inputJsonSchema: {
      additionalProperties: false,
      properties: {
        limit: {
          default: 40,
          description: 'How many trailing entries to return (1-200). Each entry text is capped at 400 characters.',
          type: 'number',
        },
        full: {
          default: false,
          description:
            'Return complete entry text up to a bounded full-read budget instead of the 400-character preview. Every entry still reports truncation metadata.',
          type: 'boolean',
        },
        target: { description: 'Bot or group name or id, for example "General".', type: 'string' },
      },
      required: ['target'],
      type: 'object',
    },
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(40),
      full: z.boolean().default(false),
      target: z.string().min(1),
    }),
    resultSchema: z.object({ entries: z.array(entrySchema), target: targetSchema }),
    title: 'Read a Grok Bot thread',
  },
  async ({ limit, target, full }) => {
    const tail = await withRedactedErrors(async () => getTranscriptTail(await connectGateway(), target, limit));
    const value = { entries: transcriptEntries(tail.transcript, { full }), target: summarizeTarget(tail.target) };
    return (
      <Agent.Result value={value}>
        <Agent.Text>{`${value.target.kind} ${value.target.name}: ${value.entries.length} entries.`}</Agent.Text>
        {value.entries.map((entry, index) => (
          <Agent.Text key={entry.id || index}>{`[${entry.role ?? entry.kind}] ${entry.text}`}</Agent.Text>
        ))}
      </Agent.Result>
    );
  },
);
