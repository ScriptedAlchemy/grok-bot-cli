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
      'Search full Desktop thread metadata by case-insensitive substring. Display titles are capped at 200 characters with titleTruncated:true. Pass nextCursor as cursor with unchanged query and filters to retrieve all matches. Dynamic hostId/hostName, modelProvider, and project filters apply. Remote results identify hostId and cannot be read on this Mac.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        query: { type: 'string', description: 'Case-insensitive substring over thread metadata.' },
        limit: { type: 'number', default: 50, description: 'Maximum matches.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the previous search page; keep query and filters unchanged.' },
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
        project: { type: 'string', description: 'Match a Desktop project label or app-server projectId.' },
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
