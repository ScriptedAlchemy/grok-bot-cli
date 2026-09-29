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
      'Open a ChatGPT Desktop sidebar thread and collect turns via local CDP (scrolls the virtualized timeline). Falls back to Codex app-server thread/read or items when CDP is unreachable; result includes backend.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        threadId: { type: 'string' },
        limit: { type: 'number' },
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
