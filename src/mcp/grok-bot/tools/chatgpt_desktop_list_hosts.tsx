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
      'Discover local, remote-control environment ids, managed SSH hosts, and modelProvider ids. hostName is null when Desktop has no real display name. Use hostId or label in list/search filters; remote thread ids must be read on the owning host. warnings report provider discovery failures.',
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
