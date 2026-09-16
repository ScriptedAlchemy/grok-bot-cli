import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import {
  sendFields,
  resultSchema as plainResultSchema,
  sendOperation,
  resultText,
} from '../../core/codex/routes.js';
import {
  codexReturnOperation,
  relayResultSchema,
} from '../../core/relay/routes.js';
export const resultSchema = z.union([plainResultSchema, relayResultSchema]);
export const inputSchema = z
  .object({
    ...sendFields,
    whenBusy: z.enum(['reject', 'queue', 'steer']).optional(),
    replyToGrok: z.string().min(1).optional(),
    bindingId: z.string().min(1).optional(),
    requestId: z.string().min(1).max(128).optional(),
    correlationId: z.string().min(1).optional(),
    replyTo: z.string().min(1).optional(),
    message: z.array(z.string()).min(1),
  })
  .strict();
export const config = {
  description:
    'Send to Codex; acceptance is distinct from completion. Options precede threadId.',
  exitCode: 'result',
  render: { maxElapsedMs: 660000 },
  positionals: ['threadId', 'message'],
  inputJsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      replyToGrok: { type: 'string' },
      bindingId: { type: 'string' },
      requestId: { type: 'string' },
      threadId: {
        type: 'string',
      },
      expectedCwd: {
        type: 'string',
      },
      timeoutMs: {
        type: 'number',
        description: 'Observation timeout: 1-600000 milliseconds.',
      },
      correlationId: {
        type: 'string',
      },
      envelope: {
        type: 'boolean',
      },
      hop: {
        type: 'number',
      },
      replyTo: {
        type: 'string',
      },
      expectedTurnId: {
        type: 'string',
        description:
          'Required active-turn guard for steer; stale guards reject.',
      },
      wait: {
        type: 'boolean',
      },
      maxOutputBytes: {
        type: 'number',
        description: 'Reply budget: 1-4194304 bytes.',
      },
      whenBusy: {
        type: 'string',
        enum: ['reject', 'queue', 'steer'],
      },
      message: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
    required: ['threadId', 'message'],
  },
} satisfies CliRouteConfig;
export default async function route({
  input,
  signal,
}: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  if (input.replyToGrok || input.bindingId) {
    const out = await codexReturnOperation(
      { ...input, message: input.message.join(' ').trim() },
      context,
    );
    return (
      <Agent.Result
        value={{ ...out, exitCode: out.delivery === 'rejected' ? 1 : 0 }}
      >
        <Agent.Text>{`Delivery ${out.delivery}; terminal answer returns to Grok automatically.`}</Agent.Text>
      </Agent.Result>
    );
  }
  const out = await sendOperation(
    {
      ...input,
      whenBusy: input.whenBusy ?? 'reject',
      message: input.message.join(' ').trim(),
    },
    signal,
    (message) => context.progress.report({ message }),
    true,
  );
  return (
    <Agent.Result value={out}>
      <Agent.Text>{resultText(out)}</Agent.Text>
    </Agent.Result>
  );
}
