import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  sendSchema,
  resultSchema as plainResultSchema,
  sendOperation,
  resultText,
} from '../../../core/codex/routes.js';
import { z } from 'zod';
import {
  codexReturnOperation,
  relayResultSchema,
} from '../../../core/relay/routes.js';
export const inputSchema = sendSchema.extend({
  whenBusy: z.enum(['reject', 'queue', 'steer']).optional(),
  replyToGrok: z.string().min(1).optional(),
  bindingId: z.string().min(1).optional(),
  requestId: z.string().min(1).max(128).optional(),
});
const resultSchema = z.union([plainResultSchema, relayResultSchema]);
export default defineTool(
  {
    excludeClients: ['codex'],
    description:
      'Send to Codex. With replyToGrok or bindingId, managed delivery returns the terminal answer to Grok automatically. Otherwise optional wait observes completion and explicit steer requires expectedTurnId. Acceptance is not completion.',
    title: 'Codex send',
    annotations: { readOnlyHint: false },
    render: { maxElapsedMs: 660000 },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        expectedCwd: {
          type: 'string',
        },
        threadId: {
          type: 'string',
        },
        timeoutMs: {
          type: 'number',
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
        },
        whenBusy: {
          type: 'string',
          enum: ['reject', 'queue', 'steer'],
        },
        wait: {
          default: false,
          type: 'boolean',
        },
        maxOutputBytes: {
          type: 'number',
        },
        message: {
          type: 'string',
        },
        replyToGrok: {
          type: 'string',
        },
        bindingId: {
          type: 'string',
        },
        requestId: {
          type: 'string',
        },
      },
      required: ['threadId', 'message'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const context = await agent();
    if (input.replyToGrok || input.bindingId) {
      const out = await codexReturnOperation(input, context);
      return (
        <Agent.Result value={out}>
          <Agent.Text>{`Delivery ${out.delivery}; terminal answer returns to Grok automatically.`}</Agent.Text>
        </Agent.Result>
      );
    }
    const out = await sendOperation(
      { ...input, whenBusy: input.whenBusy ?? 'reject' },
      context.signal,
      (message) => context.progress.report({ message }),
    );
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
