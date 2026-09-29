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
      'EXPERIMENTAL: poll ChatGPT Desktop turns via local CDP until a new assistant turn stabilizes, or time out. Falls back to Codex app-server item polling when CDP is unreachable; result includes backend.',
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
      required: ['threadId'],
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
