import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  resultSchema,
  resultText,
  waitReplyOperation,
  waitReplySchema as inputSchema,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop wait for reply',
    description:
      'Wait until main Stop is gone and a new [data-local-conversation-final-assistant=true] exists, then return assistant markdown text. Also returns conversationId from data-response-annotation-conversation (resolves temporary local:client-new-thread ids). CDP only — does not use app-server.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 660000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: [],
    },
  },
  async (input) => {
    const out = await waitReplyOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
