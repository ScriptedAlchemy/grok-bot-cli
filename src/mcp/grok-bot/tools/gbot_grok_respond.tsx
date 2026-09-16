import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { respondSchema as inputSchema, resultSchema, respondOperation } from '../../../core/grok-approval-routes.js';
export { inputSchema };
export default defineTool({
  title: 'Respond to Grok approval', description: 'Only after an explicit user decision: accept one current Grok approval once or decline it. Exact target, entryId and approval requestId required. Never auto-approve or grant persistent permissions. Success acknowledges response delivery, not execution.',
  annotations: { readOnlyHint: false }, inputSchema, resultSchema,
  inputJsonSchema: {
    type: 'object', properties: {
      target: { type: 'string' }, entryId: { type: 'string' }, requestId: { type: 'string' },
      decision: { type: 'string', enum: ['accept', 'decline'] },
    }, required: ['target', 'entryId', 'requestId', 'decision'], additionalProperties: false,
  },
}, async input => {
  const out = await respondOperation(input);
  return <Agent.Result value={out}><Agent.Text>{JSON.stringify(out)}</Agent.Text></Agent.Result>;
});
