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
      'EXPERIMENTAL: send a message in ChatGPT Desktop via local CDP composer (Input.insertText / contenteditable). Omit threadId to use the current/new chat. Falls back to Codex app-server send when CDP is unreachable and threadId is set; result includes backend.',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    render: { maxElapsedMs: 120000 },
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string', description: 'Sidebar thread id; omit to start/use a new chat.' },
        text: { type: 'string' },
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
