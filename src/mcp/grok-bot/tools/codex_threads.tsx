import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { threadsSchema as inputSchema, resultSchema, threadsOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  description: 'Discover a bounded page of Codex daemon threads.', title: 'Codex threads', annotations: { readOnlyHint: true },
  render: { maxElapsedMs: 660000 },
  inputSchema, resultSchema,
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
      "limit": {
        "type": "number",
        "description": "Maximum threads in this page: 1-200."
      },
      "cursor": {
        "type": "string"
      }
    }, required: [] },
}, async input => {
  const context = await agent();
  const out = await threadsOperation(input);
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
