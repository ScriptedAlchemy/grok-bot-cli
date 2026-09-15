import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { buildEnvelope, sendToCodexThread } from '../../core/codex-bridge.js';
import { outcomeFromError } from '../../core/codex/contract.js';

export const config = {
  description:
    'Send a message to a Codex thread. Options go before <threadId>; `--` protects flag-like text.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      correlationId: { description: 'Stable correlation id for multi-hop replies', type: 'string' },
      envelope: {
        description: 'Prepend the [gbot …] header to the message body',
        type: 'boolean',
      },
      hop: { description: 'Hop count; refused at GROK_BOT_MAX_HOPS', type: 'number' },
      message: { items: { type: 'string' }, type: 'array' },
      replyTo: { description: 'Prior message id this send replies to', type: 'string' },
      threadId: { type: 'string' },
      whenBusy: {
        description: 'reject (default) or queue (needs GROK_BOT_CODEX_EXPERIMENTAL=1)',
        enum: ['reject', 'queue'],
        type: 'string',
      },
    },
    required: ['threadId', 'message'],
    type: 'object',
  },
  positionals: ['threadId', 'message'],
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    correlationId: z.string().min(1).optional(),
    envelope: z.boolean().optional(),
    hop: z.number().int().min(0).optional(),
    message: z.array(z.string()).min(1),
    replyTo: z.string().min(1).optional(),
    threadId: z.string().min(1),
    whenBusy: z.enum(['reject', 'queue']).default('reject'),
  })
  .strict();

export const resultSchema = z
  .object({
    delivery: z.enum(['accepted', 'queued', 'rejected', 'unknown']),
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .passthrough();

export default async function codexSend({ input }: CliRouteProps<typeof inputSchema>) {
  let out;
  try {
    const envelope = buildEnvelope({
      correlationId: input.correlationId,
      envelope: Boolean(input.envelope),
      hop: input.hop,
      replyTo: input.replyTo,
    });
    out = await sendToCodexThread(input.threadId, input.message.join(' ').trim(), {
      envelope,
      whenBusy: input.whenBusy,
    });
  } catch (error) {
    out = outcomeFromError(error);
  }
  const text =
    out.delivery === 'queued' && typeof out.queuedSubmissionId === 'string'
      ? `Queued ${out.queuedSubmissionId} on busy Codex thread ${out.threadId}; message ${out.messageId}`
      : out.exitCode === 0
        ? `Started turn ${out.turnId} (${out.turnStatus}) on Codex thread ${out.threadId}; message ${out.messageId}`
        : typeof out.error === 'string'
          ? out.error
          : `Codex delivery ${out.delivery} on thread ${out.threadId}`;
  return (
    <Agent.Result value={out}>
      <Agent.Text>{text}</Agent.Text>
    </Agent.Result>
  );
}
