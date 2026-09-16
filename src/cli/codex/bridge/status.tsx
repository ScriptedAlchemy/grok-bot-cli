import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import {
  bridgeStatusSchema as inputSchema,
  relayResultSchema as resultSchema,
  bridgeOperation,
} from '../../../core/relay/routes.js';
import { outcomeFromError } from '../../../core/codex/contract.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'Managed Grok/Codex bridge status.',
  exitCode: 'result',
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
} satisfies CliRouteConfig;
export default async function route({
  input,
}: CliRouteProps<typeof inputSchema>) {
  let out;
  try {
    out = {
      ...(await bridgeOperation('status', input, await agent())),
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
