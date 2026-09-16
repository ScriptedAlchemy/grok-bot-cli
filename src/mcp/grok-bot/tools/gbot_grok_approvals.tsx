import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { listSchema as inputSchema, resultSchema, listOperation } from '../../../core/grok-approval-routes.js';
export { inputSchema };
export default defineTool({
  excludeClients: ['grok bot', 'grokbot', 'grok-bot'],
  title: 'Pending Grok approvals', description: 'List pending auto-review and local-tool approval cards in the latest 200 entries for a Grok bot. Older or unsupported requests require the owning Grok UI.',
  annotations: { readOnlyHint: true }, inputSchema, resultSchema,
  inputJsonSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
}, async input => {
  const out = await listOperation(input);
  return <Agent.Result value={out}><Agent.Text>{JSON.stringify(out)}</Agent.Text></Agent.Result>;
});
