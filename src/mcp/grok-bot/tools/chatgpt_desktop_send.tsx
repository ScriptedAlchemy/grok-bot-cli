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
      'Send a message in ChatGPT Desktop via local CDP only: focus [data-codex-composer], Input.insertText, Enter (Send button fallback). Omit threadId to start a new chat; pass project to prefer "Start new chat in <project>". After a new-thread send, waits for data-response-annotation-conversation and returns that durable id as threadId (never local:client-new-thread:*). temporaryThreadId may still name the brief sidebar row. Does not use app-server.',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 180000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string', description: 'Sidebar thread id; omit to start a new chat.' },
        text: { type: 'string' },
        project: {
          type: 'string',
          description: 'Preferred project for new chats (Start new chat in <project>).',
        },
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
