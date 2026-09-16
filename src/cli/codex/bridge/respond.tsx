import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import {
  respondSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
import { outcomeFromError } from '../../../core/codex/contract.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'Managed Grok/Codex bridge respond.',
  exitCode: 'result',
  inputJsonSchema: {
    type: 'object',
    properties: {
      interactionId: {
        type: 'string',
      },
      generation: {
        type: 'string',
      },
      threadId: {
        type: 'string',
      },
      turnId: {
        type: 'string',
      },
      bindingId: {
        type: 'string',
      },
      exchangeId: {
        type: 'string',
      },
      decision: {
        type: 'string',
        enum: ['accept', 'decline', 'cancel'],
      },
      answersJson: {
        type: 'string',
        description:
          'JSON object mapping each advertised question ID to {"answers":["answer"]}; exact IDs required.',
      },
    },
    required: ['interactionId', 'generation', 'threadId', 'turnId'],
    additionalProperties: false,
  },
} satisfies CliRouteConfig;
export default async function route({
  input,
}: CliRouteProps<typeof inputSchema>) {
  let out;
  try {
    out = {
      ...(await bridgeOperation('respond', input, await agent())),
      exitCode: 0,
    };
  } catch (error) {
    out = outcomeFromError(error);
  }
  return (
    <Agent.Result value={out}>
      <Agent.Text>{JSON.stringify(out)}</Agent.Text>
    </Agent.Result>
  );
}
