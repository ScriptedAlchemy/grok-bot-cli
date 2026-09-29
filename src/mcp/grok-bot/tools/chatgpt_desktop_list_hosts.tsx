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
      'Discover local, remote-control, and managed SSH hosts from Desktop state, including nested remote-thread summaries. Host names are null when Desktop has no display name. Providers come from paged app-server inventory and remote summaries. Result includes sources and discovery warnings.',
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
