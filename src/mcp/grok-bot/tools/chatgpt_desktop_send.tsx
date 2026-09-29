import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  resultSchema,
  resultText,
  sendOperation,
  sendSchema as inputSchema,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop send',
    description:
      'Send once through local Desktop CDP. With threadId, accept local:<conversationId>, bare durable id, or currently selected local:client-new-thread:*; remote ids must be sent on their hostId. Omit threadId and project for a new chat outside projects; omit threadId and set project for a new chat inside it. New-thread receipts include temporaryThreadId when seen and return durable local:<conversationId> once resolved. ARCHIVED_THREAD rejects without sending; unarchive:true explicitly unarchives that existing thread first. CDP_UNREACHABLE and COMPOSER_HAS_DRAFT require operator inspection, not blind retry.',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 180000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string', description: 'local:<conversationId>, bare durable id, or selected local:client-new-thread:*; omit for a new chat.' },
        text: { type: 'string' },
        project: {
          type: 'string',
          description: 'With threadId omitted, create the new chat inside this project. Omit for a new chat outside projects.',
        },
        unarchive: { type: 'boolean', default: false, description: 'Existing threadId only: explicitly call thread/unarchive after ARCHIVED_THREAD, then retry the send once. Never implicit.' },
        openTimeoutMs: { type: 'number' },
      },
      required: ['text'],
    },
  },
  async (input) => {
    const out = await sendOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
