import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { respondSchema as inputSchema, resultSchema, respondOperation } from '../../core/grok-approval-routes.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'Explicit user decision: accept a Grok request once or decline; never grant persistent permissions.',
  inputJsonSchema: {
    type: 'object', properties: {
      target: { type: 'string' }, entryId: { type: 'string' }, requestId: { type: 'string' },
      decision: { type: 'string', enum: ['accept', 'decline'] },
    }, required: ['target', 'entryId', 'requestId', 'decision'], additionalProperties: false,
  },
} satisfies CliRouteConfig;
export default async function route({ input }: CliRouteProps<typeof inputSchema>) {
  const out = await respondOperation(input);
  return <Agent.Result value={out}><Agent.Text>{JSON.stringify(out)}</Agent.Text></Agent.Result>;
}
