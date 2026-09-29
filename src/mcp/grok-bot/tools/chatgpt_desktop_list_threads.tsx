import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  listThreadsOperation,
  listThreadsSchema as inputSchema,
  resultSchema,
  resultText,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop list threads',
    description:
      'List ChatGPT Desktop / Codex threads: local app-server thread/list (modelProviders:[]) merged with remote-control summaries from ~/.codex/.codex-global-state.json (remote-thread-summaries-v3:<hostId>). Each thread has location local|remote and hostId/hostName. Optional host filter and groupBy=host. Merges CDP selected when connected. Result includes backend.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        limit: { type: 'number', description: 'Maximum threads (1-200).' },
        host: {
          type: 'string',
          description: 'Filter by hostId or friendly host/env name (use "local" for local-only).',
        },
        groupBy: {
          type: 'string',
          enum: ['host'],
          description: 'When "host", also return groups[] keyed by host.',
        },
      },
      required: [],
    },
  },
  async (input) => {
    const out = await listThreadsOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
