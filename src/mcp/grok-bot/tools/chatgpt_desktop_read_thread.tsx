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
      'Read a ChatGPT Desktop thread. Visible/recent turns use local CDP DOM harvest. full=true or a limit above the on-screen turns uses the Codex app-server (thread/read / resume); Desktop local:<conversationId> maps to the bare app-server id. DOM wheel crawl is only a fallback when app-server misses the thread. Result includes backend.',
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
            'When true, read full history via app-server (CDP wheel only if app-server unavailable). Default false = visible CDP turns when that satisfies limit.',
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
