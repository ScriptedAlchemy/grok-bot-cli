import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  readThreadOperation,
  readThreadSchema as inputSchema,
  resultSchema,
  resultText,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop read thread',
    description:
      'Read a local:<conversationId>, bare durable id, or selected temporary local:client-new-thread:* id. Pass nextCursor back as cursor with the same threadId/full mode until complete:true. Pages stop at a byte budget; oversized turns use ordered continuation fragments with stable turnKey and field offsets, without dropping text. Archived threads remain readable. Warnings explain partial pages or app-server errors. REMOTE_THREAD_NOT_LOADED includes the owning hostId: call on that host.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 660000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: {
          type: 'string',
          description:
            'local:<conversationId>, bare durable id, or selected local:client-new-thread:* temporary id. Remote ids return REMOTE_THREAD_NOT_LOADED with hostId.',
        },
        limit: { type: 'number' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the prior read page. Keep threadId and full unchanged.' },
        full: {
          type: 'boolean',
          description:
            'When true, page from the start through the complete history (up to 2000 turns by default); otherwise return the most recent 100 turns by default. Explicit limit bounds either mode.',
        },
        openTimeoutMs: {
          type: 'number',
          description: 'Max wait for Loading task… to clear after opening (default 90000).',
        },
      },
      required: ['threadId'],
    },
  },
  async (input) => {
    const out = await readThreadOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
