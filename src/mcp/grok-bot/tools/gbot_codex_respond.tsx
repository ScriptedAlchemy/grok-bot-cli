import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  respondSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
export { inputSchema };
export default defineTool(
  {
    excludeClients: ['codex'],
    description:
      'Explicit operator response to a current scoped Codex interaction. Supports only one-time accept/decline/cancel or exact question-ID answers. Never auto-approve.',
    title: 'gbot_codex_respond',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        interactionId: {
          type: 'string',
        },
        generation: {
          type: 'string',
        },
        threadId: {
          type: 'string',
        },
        turnId: {
          type: 'string',
        },
        bindingId: {
          type: 'string',
        },
        exchangeId: {
          type: 'string',
        },
        decision: {
          type: 'string',
          enum: ['accept', 'decline', 'cancel'],
        },
        answersJson: {
          type: 'string',
          description:
            'JSON object mapping each advertised question ID to {"answers":["answer"]}; exact IDs required.',
        },
      },
      required: ['interactionId', 'generation', 'threadId', 'turnId'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const out = await bridgeOperation('respond', input, await agent());
    return (
      <Agent.Result value={out}>
        <Agent.Text>{JSON.stringify(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
