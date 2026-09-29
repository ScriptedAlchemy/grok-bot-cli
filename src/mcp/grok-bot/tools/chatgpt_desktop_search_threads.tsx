import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  resultSchema,
  resultText,
  searchThreadsOperation,
  searchThreadsSchema as inputSchema,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop search threads',
    description:
      'Search ChatGPT Desktop / Codex threads through the local app-server (thread/list with modelProviders:[]), matching name/preview/cwd/project/model fields. Merges CDP selected/pinned when connected. Result includes backend.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        query: { type: 'string', description: 'Case-insensitive substring over thread metadata.' },
        limit: { type: 'number', description: 'Maximum matches (1-200).' },
      },
      required: ['query'],
    },
  },
  async (input) => {
    const out = await searchThreadsOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
