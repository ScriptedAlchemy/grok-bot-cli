import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { formatTranscript } from '../core/format.js';
import { saveHistory } from '../core/history.js';
import { transcriptDelta } from '../core/transcript.js';
import {
  backendFlagsSchema,
  openBackendFromInput,
} from './_shared.js';

export const config = {
  description: 'Read the most recent messages in a Grok Bot bot or group thread.',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      after: { description: 'Return entries after this opaque entry id', type: 'string' },
      dir: { description: 'Agents directory for --files mode', type: 'string' },
      files: { description: 'Force the on-disk agents store', type: 'boolean' },
      full: { description: 'Show full entry text in human output', type: 'boolean' },
      gateway: { description: 'Force the live gateway', type: 'boolean' },
      historyDir: { description: 'Directory containing history.jsonl', type: 'string' },
      limit: { default: 40, description: 'How many trailing entries to return (1-200)', type: 'number' },
      noHistory: { description: 'Skip local history for this command', type: 'boolean' },
      root: { description: 'Read one rooted thread by message id', type: 'string' },
      target: { type: 'string' },
    },
    required: ['target'],
    type: 'object',
  },
  positionals: ['target'],
} satisfies CliRouteConfig;

export const inputSchema = backendFlagsSchema
  .extend({
    after: z.string().min(1).max(1024).optional(),
    full: z.boolean().default(false),
    historyDir: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(40),
    noHistory: z.boolean().default(false),
    root: z.string().min(1).optional(),
    target: z.string().min(1),
  })
  .strict()
  .refine((input) => input.after === undefined || input.root === undefined, '--after cannot be combined with --root');

export const resultSchema = z.record(z.string(), z.json());

export default async function thread({ input }: CliRouteProps<typeof inputSchema>) {
  const backend = await openBackendFromInput(input);
  if (input.root !== undefined) {
    const rooted = await backend.thread(input.target, input.root);
    saveHistory(rooted, {
      dir: input.historyDir,
      disabled: input.noHistory,
      event: 'thread',
      rootId: input.root,
    });
    return (
      <Agent.Result value={rooted}>
        <Agent.Text>{formatTranscript(rooted, { full: input.full })}</Agent.Text>
      </Agent.Result>
    );
  }
  const out = await backend.transcript(input.target, input.limit);
  if (input.after !== undefined) {
    const delta = transcriptDelta(out.transcript, { after: input.after, limit: input.limit });
    const selected = {
      ...out,
      transcript: { entries: delta.entries },
      cursor: delta.cursor,
      entryCount: delta.entryCount,
      gapReset: delta.gapReset,
    };
    saveHistory(selected, {
      dir: input.historyDir,
      disabled: input.noHistory,
      event: 'thread',
    });
    const text = formatTranscript(selected, { full: input.full });
    return (
      <Agent.Result value={selected}>
        <Agent.Text>{`${text}\n\ncursor: ${delta.cursor}${delta.gapReset ? ' (gap reset)' : ''}`}</Agent.Text>
      </Agent.Result>
    );
  }
  saveHistory(out, {
    dir: input.historyDir,
    disabled: input.noHistory,
    event: 'thread',
  });
  return (
    <Agent.Result value={out}>
      <Agent.Text>{formatTranscript(out, { full: input.full })}</Agent.Text>
    </Agent.Result>
  );
}
