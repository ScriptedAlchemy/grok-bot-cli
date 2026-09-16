import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  bridgeStatusSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
export { inputSchema };
export default defineTool(
  {
    description:
      'Inspect worker health, route coverage, bounded receipts and scoped pending operator interactions.',
    title: 'gbot_bridge_status',
    annotations: { readOnlyHint: true },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        bindingId: {
          type: 'string',
        },
        limit: {
          type: 'number',
        },
      },
      additionalProperties: false,
    },
  },
  async (input) => {
    const out = await bridgeOperation('status', input, await agent());
    return (
      <Agent.Result value={out}>
        <Agent.Text>{JSON.stringify(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
