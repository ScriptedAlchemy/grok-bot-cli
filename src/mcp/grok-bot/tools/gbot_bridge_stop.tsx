import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  bridgeStopSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
export { inputSchema };
export default defineTool(
  {
    description:
      'Stop a binding without deleting receipts or interrupting Codex. all stops all bindings; worker explicitly shuts down the worker.',
    title: 'gbot_bridge_stop',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        bindingId: {
          type: 'string',
        },
        all: {
          type: 'boolean',
        },
        worker: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  async (input) => {
    const out = await bridgeOperation('stop', input, await agent());
    return (
      <Agent.Result value={out}>
        <Agent.Text>{JSON.stringify(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
