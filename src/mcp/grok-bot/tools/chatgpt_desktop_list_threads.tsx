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
      'List ChatGPT Desktop / Codex threads: local app-server thread/list merged with remote-control summaries from ~/.codex/.codex-global-state.json. Separate filters: host (all|local|<hostId or friendly name>, default all) and modelProvider (passed through as modelProviders; omit/empty = all). Optional groupBy=host. Each thread has location local|remote and hostId/hostName. Discover hosts via chatgpt_desktop_list_hosts. Result includes backend.',
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
