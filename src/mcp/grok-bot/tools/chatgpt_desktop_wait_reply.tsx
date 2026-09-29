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
      'After chatgpt_desktop_send, wait for the selected Desktop reply over CDP. Accept the returned durable local:<conversationId> or the temporary local:client-new-thread:* while selected; omit threadId only when staying on the same selected chat. Returns reply, durable threadId and conversationId. timeout is not proof the send failed; CDP_UNREACHABLE requires Desktop recovery. Remote ids must be handled on their hostId.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 660000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string', description: 'Durable local:<conversationId>, bare id, or selected local:client-new-thread:* from send.' },
        timeoutMs: { type: 'number', default: 120000 },
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
