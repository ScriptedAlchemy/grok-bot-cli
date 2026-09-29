import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  listHostsOperation,
  listHostsSchema as inputSchema,
  resultSchema,
  resultText,
} from '../../../core/chatgpt-desktop/routes.js';

export { inputSchema };

export default defineTool(
  {
    title: 'ChatGPT Desktop list hosts',
    description:
      'Discover ChatGPT Desktop hosts dynamically: always includes local, plus every remote-thread-summaries-v3:<hostId> key from ~/.codex/.codex-global-state.json (friendly names + thread counts). Also reports modelProviders discovered via an app-server list method when present, otherwise distinct modelProvider values from thread/list. Use this instead of hardcoding host ids. Result includes hostsSource and modelProvidersSource.',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        port: { type: 'number' },
      },
      required: [],
    },
  },
  async (input) => {
    const out = await listHostsOperation(input);
    return (
      <Agent.Result value={out}>
        <Agent.Text>{resultText(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
