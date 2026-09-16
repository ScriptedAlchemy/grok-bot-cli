import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { sendSchema as inputSchema, resultSchema, sendOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  description: 'Send to a Codex thread. Accepted means submitted, not finished; optional wait observes bounded completion. Guarded steer requires expectedTurnId.', title: 'Codex send', annotations: { readOnlyHint: false },
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
      "correlationId": {
        "type": "string"
      },
      "envelope": {
        "type": "boolean"
      },
      "hop": {
        "type": "number"
      },
      "replyTo": {
        "type": "string"
      },
      "expectedTurnId": {
        "type": "string",
        "description": "Required active-turn guard for steer; stale guards reject."
      },
      "wait": {
        "type": "boolean"
      },
      "maxOutputBytes": {
        "type": "number",
        "description": "Reply budget: 1-4194304 bytes."
      },
      "whenBusy": {
        "type": "string",
        "enum": [
          "reject",
          "queue",
          "steer"
        ]
      },
      "message": {
        "type": "string"
      }
    }, required: ['threadId', 'message'] },
}, async input => {
  const context = await agent();
  const out = await sendOperation(input, context.signal, message => context.progress.report({ message }));
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
