import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { watchSchema as inputSchema, resultSchema, observeOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  excludeClients: ['codex'],
  description: 'Watch bounded Codex thread events for diagnostics without answering approvals.', title: 'Codex watch', annotations: { readOnlyHint: true },
  render: { maxElapsedMs: 660000 },
  inputSchema, resultSchema,
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
}, async input => {
  const context = await agent();
  const out = await observeOperation('watch', input, context.signal, message => context.progress.report({ message }));
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
