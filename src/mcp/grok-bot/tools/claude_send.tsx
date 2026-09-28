import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { inputSchema, resultSchema, sendOperation } from '../../../core/claude-routes.js';
export { inputSchema };
export default defineTool({
  title: 'Message Claude Code',
  description: 'Send to a named, opted-in live Claude Code channel and wait for its reply. Unknown delivery must not be retried automatically. Runs on the user\'s registered machine via its local socket, not the Grok Bot box. From the box, use Grok Bot Shell with a machineId to run gbot there after codex app-server daemon start or bootstrap; gbot has no remote transport.',
  annotations: { readOnlyHint: false },
  inputSchema, resultSchema, inputJsonSchema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, message: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['name', 'message'] },
  render: { maxElapsedMs: 130000 },
}, async input => {
  const result = await sendOperation(input);
  return <Agent.Result value={result}><Agent.Text>{result.reply ?? result.error ?? result.delivery}</Agent.Text></Agent.Result>;
});
