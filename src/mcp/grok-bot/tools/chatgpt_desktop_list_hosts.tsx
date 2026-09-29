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
      'Discover ChatGPT Desktop hosts and modelProviders at runtime. Hosts come from local and remote-thread-summaries-v3:<hostId> metadata; providers are distinct thread/list and remote-summary values. New connections appear without code changes. Result includes hostsSource and modelProvidersSource',
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
