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
      'Open a ChatGPT Desktop sidebar thread (waits for Loading task… up to openTimeoutMs, default 90s) and harvest turns via local CDP. Default is visible turns only; full=true mouse-wheels the column-reverse timeline for history (skips history-gap placeholders). Falls back to Codex app-server when CDP is unreachable; result includes backend.',
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
        limit: { type: 'number' },
        full: {
          type: 'boolean',
          description: 'When true, wheel-crawl older history (slow). Default false = visible turns only.',
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
