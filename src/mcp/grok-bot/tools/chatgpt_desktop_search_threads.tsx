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
      'Search ChatGPT Desktop / Codex threads through the local app-server and remote-control summaries. Separate filters host and modelProvider accept any string (not enums) — discover allowed values via chatgpt_desktop_list_hosts. Optional groupBy=host. Result includes backend.',
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
            'Any string filter for machine/location. Reserved: "all" (default), "local". Otherwise a hostId or friendly name discovered at runtime — see chatgpt_desktop_list_hosts. Not an enum; new machines/connections appear with no code change.',
        },
        modelProvider: {
          type: 'string',
          description:
            'Any modelProvider id string (passed through to app-server modelProviders). Omit for all providers. Discovered values: see chatgpt_desktop_list_hosts. Not an enum.',
        },
        groupBy: {
          type: 'string',
          enum: ['host'],
          description: 'When "host", also return groups[] keyed by host (grouping mode, not a host id).',
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
