import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { waitSchema as inputSchema, resultSchema, observeOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  excludeClients: ['codex'],
  description: 'Explicit diagnostic observation of one Codex turn; returns execution and final reply without interrupting it.', title: 'Codex wait', annotations: { readOnlyHint: true },
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
      "turnId": {
        "type": "string"
      },
      "messageId": {
        "type": "string"
      },
      "maxOutputBytes": {
        "type": "number",
        "description": "Reply budget: 1-4194304 bytes."
      }
    }, required: ['threadId', 'turnId'] },
}, async input => {
  const context = await agent();
  const out = await observeOperation('wait', input, context.signal, message => context.progress.report({ message }));
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
