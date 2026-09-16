import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { watchSchema as inputSchema, resultSchema, observeOperation, resultText } from '../../core/codex/routes.js';
export { inputSchema, resultSchema };
export const config = {
  description: 'Bounded Codex watch observation; never interrupts execution.', exitCode: 'result', render: { maxElapsedMs: 660000 },
  positionals: ['threadId'],
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
      "threadId": {
        "type": "string"
      },
      "expectedCwd": {
        "type": "string"
      },
      "timeoutMs": {
        "type": "number",
        "description": "Observation timeout: 1-600000 milliseconds."
      },
      "maxEvents": {
        "type": "number",
        "description": "Maximum observed events: 1-500."
      }
    }, required: ['threadId'] },
} satisfies CliRouteConfig;
export default async function route({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const out = await observeOperation('watch', input, signal, message => context.progress.report({ message }));
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
}
