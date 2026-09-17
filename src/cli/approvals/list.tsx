import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { listSchema as inputSchema, resultSchema, listOperation } from '../../core/grok-approval-routes.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'List current Grok approval cards (latest 200 entries).', positionals: ['target'],
  inputJsonSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
} satisfies CliRouteConfig;
export default async function route({ input }: CliRouteProps<typeof inputSchema>) {
  const out = await listOperation(input);
  return <Agent.Result value={out}><Agent.Text>{JSON.stringify(out)}</Agent.Text></Agent.Result>;
}
