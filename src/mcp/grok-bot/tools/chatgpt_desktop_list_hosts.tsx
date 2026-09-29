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
      'Discover ChatGPT Desktop hosts and modelProviders at runtime — never hardcode them. Hosts: always local, plus every remote-thread-summaries-v3:<hostId> key from ~/.codex/.codex-global-state.json (friendly names + thread counts), merged with any app-server remote-environment/connection list method when present. Providers: app-server list method when present, else distinct modelProvider values from thread/list. New machines/connections Zack adds later show up with no code change. Result includes hostsSource and modelProvidersSource.',
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
