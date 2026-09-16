import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  grokSendSchema as inputSchema,
  relayResultSchema as resultSchema,
  grokSendOperation,
} from '../../../core/relay/routes.js';
export { inputSchema };
export default defineTool(
  {
    excludeClients: ['grok bot', 'grokbot', 'grok-bot'],
    description:
      'Send to Grok Bot. Native Codex calls automatically receive replies in their originating thread; send once and continue work. Without a native source, supply codexThreadId or use manual gbot_thread reading.',
    title: 'Send a message to Grok Bot',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        hop: {
          type: 'number',
          description:
            'Explicit chain hop count, refused at the configured bound.',
        },
        correlationId: { type: 'string' },
        target: {
          type: 'string',
        },
        message: {
          type: 'string',
        },
        replyMode: {
          type: 'string',
          enum: ['auto', 'manual'],
        },
        codexThreadId: {
          type: 'string',
        },
        expectedCwd: {
          type: 'string',
        },
        bindingId: {
          type: 'string',
        },
        requestId: {
          type: 'string',
        },
      },
      required: ['target', 'message'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const out = await grokSendOperation(input, await agent());
    return (
      <Agent.Result value={out}>
        <Agent.Text>
          {out.replyRoute.mode === 'auto'
            ? `Delivery ${out.delivery}; replies will arrive in Codex thread ${out.replyRoute.threadId}. Continue work; no polling needed.`
            : `Delivery ${out.delivery}${out.delivery === 'unknown' ? ' (no receipt; check the thread before resending)' : ''}; read the reply with gbot_thread.`}
        </Agent.Text>
      </Agent.Result>
    );
  },
);
