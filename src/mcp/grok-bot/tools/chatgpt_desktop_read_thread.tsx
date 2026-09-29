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
      'Read paged ChatGPT Desktop turns through app-server, including userText, assistantText, and completedAt as endedAt. Remote-only threads return REMOTE_THREAD_NOT_LOADED with hostId. CDP fallback reports complete:false and a warning when app-server fails. Result includes backend.',
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
            'Desktop sidebar id (local:<conversationId>) or bare app-server thread id.',
        },
        limit: { type: 'number' },
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
