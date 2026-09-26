import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { inputSchema, resultSchema, sendOperation } from '../../core/claude-routes.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'Send to an explicitly enabled live Claude Code channel and wait for its reply.',
  positionals: ['name', 'message'],
  exitCode: 'result', inputJsonSchema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, message: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['name', 'message'] },
  render: { maxElapsedMs: 130000 },
} satisfies CliRouteConfig;
export default async function send({ input }: CliRouteProps<typeof inputSchema>) {
  const result = await sendOperation(input);
  return <Agent.Result value={result}><Agent.Text>{result.reply ?? result.error ?? result.delivery}</Agent.Text></Agent.Result>;
}
