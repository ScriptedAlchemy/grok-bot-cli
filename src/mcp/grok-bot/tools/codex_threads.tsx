import { Agent, agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { threadsSchema as inputSchema, resultSchema, threadsOperation, resultText } from '../../../core/codex/routes.js';
export { inputSchema };
export default defineTool({
  excludeClients: ['codex'],
  description: 'Discover a bounded page of Codex daemon threads. Runs on the user\'s registered machine via its local socket, not the Grok Bot box. From the box, use Grok Bot Shell with a machineId to run gbot there after codex app-server daemon start or bootstrap; gbot has no remote transport.', title: 'Codex threads', annotations: { readOnlyHint: true },
  render: { maxElapsedMs: 660000 },
  inputSchema, resultSchema,
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
      "limit": {
        "type": "number",
        "description": "Maximum threads in this page: 1-200. Pass modelProviders:[] internally so every provider is included; use cursor/nextCursor to page."
      },
      "cursor": {
        "type": "string",
        "description": "Opaque nextCursor from a previous page."
      }
    }, required: [] },
}, async input => {
  const context = await agent();
  const out = await threadsOperation(input);
  return <Agent.Result value={out}><Agent.Text>{resultText(out)}</Agent.Text></Agent.Result>;
});
