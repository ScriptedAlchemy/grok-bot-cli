import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import {
  bridgeStartSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
export { inputSchema };
export default defineTool(
  {
    description:
      'Link a Grok conversation to Codex once. New visible Grok messages arrive automatically and Codex final answers return to Grok.',
    title: 'gbot_bridge_start',
    annotations: { readOnlyHint: false },
    inputSchema,
    resultSchema,
    inputJsonSchema: {
      type: 'object',
      properties: {
        grokTarget: {
          type: 'string',
        },
        codexThreadId: {
          type: 'string',
        },
        expectedCwd: {
          type: 'string',
        },
        busyPolicy: {
          type: 'string',
          enum: ['steer', 'reject'],
        },
        requestId: {
          type: 'string',
        },
      },
      required: ['grokTarget'],
      additionalProperties: false,
    },
  },
  async (input) => {
    const out = await bridgeOperation('startBinding', input, await agent());
    return (
      <Agent.Result value={out}>
        <Agent.Text>{JSON.stringify(out)}</Agent.Text>
      </Agent.Result>
    );
  },
);
