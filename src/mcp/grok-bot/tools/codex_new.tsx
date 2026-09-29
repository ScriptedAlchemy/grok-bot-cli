import { Agent } from '@agent-bundle/runtime';
import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';
import { startCodexThread } from '../../../core/codex-bridge.js';
import { outcomeFromError } from '../../../core/codex/contract.js';
import { resultSchema, resultText } from '../../../core/codex/routes.js';

export const inputSchema = z.object({
  cwd: z.string().min(1), expectedCwd: z.string().min(1).optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  message: z.string().min(1).optional(),
}).strict();
export default defineTool({
  excludeClients: ['codex'], title: 'Codex new thread',
  description: 'Start a new Codex thread on this machine in cwd, optionally sending its first message. Codex must run locally on the same machine as gbot.',
  annotations: { readOnlyHint: false }, inputSchema, resultSchema,
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
    cwd: { type: 'string' }, expectedCwd: { type: 'string' }, model: { type: 'string' },
    effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    message: { type: 'string' },
  }, required: ['cwd'] },
}, async input => {
  let out;
  try { out = await startCodexThread(input); }
  catch (error) { out = outcomeFromError(error); }
  return <Agent.Result value={out}><Agent.Text>{out.threadId && !('delivery' in out) ? `Started Codex thread ${out.threadId}` : resultText(out)}</Agent.Text></Agent.Result>;
});
