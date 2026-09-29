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
      'Page ChatGPT Desktop / Codex threads with cursor and nextCursor. Merges local app-server rows, CDP sidebar rows, and nested remote-control summaries. Discover dynamic host and modelProvider filters via chatgpt_desktop_list_hosts. Optional groupBy=host. Result reports the contributing backends and warnings.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        limit: { type: 'number', description: 'Maximum threads (1-200).' },
        cursor: { type: 'string', description: 'Opaque nextCursor from a previous page.' },
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
