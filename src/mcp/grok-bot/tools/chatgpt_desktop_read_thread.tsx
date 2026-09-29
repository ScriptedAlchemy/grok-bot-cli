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
      'Read a ChatGPT Desktop / Codex thread through app-server (thread/read metadata, then thread/turns/list with itemsView full). Does not thread/resume. Desktop local:<conversationId> is normalized to the bare id. Remote-control threads return REMOTE_THREAD_NOT_LOADED with hostId and a hint to read via that host\'s app-server. DOM harvest is fallback only when local app-server is unavailable. Result includes backend.',
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
            'When true, page more of the turn history from the start; otherwise return the most recent `limit` turns from app-server. CDP wheel only if app-server is unavailable.',
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
