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
      'List Desktop threads, then pass nextCursor as cursor until null. Pages may stop early at the MCP byte budget. Display titles are capped at 200 characters with titleTruncated:true. Filter by dynamic hostId/hostName, modelProvider, or project label/projectId. Rows expose local:<conversationId>, location, hostId, and provider; remote rows require their owning host for reading or sending. Backend and warnings identify partial sources.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
        limit: { type: 'number', default: 50, description: 'Maximum threads per page.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from the prior page; keep filters unchanged.' },
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
        project: { type: 'string', description: 'Match a Desktop project label or app-server projectId. Dynamic string, not an enum.' },
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
