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
      'Search ChatGPT Desktop / Codex threads through the local app-server and remote-control summaries. Separate filters: host (all|local|<hostId or friendly name>) and modelProvider (app-server modelProviders pass-through). Optional groupBy=host. Discover hosts via chatgpt_desktop_list_hosts. Result includes backend.',
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
        host: {
          type: 'string',
          description:
            'Machine/location filter: "all" (default), "local", or a hostId / friendly name from chatgpt_desktop_list_hosts.',
        },
        modelProvider: {
          type: 'string',
          description:
            'Filter passed through to app-server thread/list modelProviders. Omit for all providers.',
        },
        groupBy: {
          type: 'string',
          enum: ['host'],
          description: 'When "host", also return groups[] keyed by host.',
        },
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
