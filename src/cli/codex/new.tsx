import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';
import { startCodexThread } from '../../core/codex-bridge.js';
import { outcomeFromError } from '../../core/codex/contract.js';
import { resultSchema, resultText } from '../../core/codex/routes.js';

export const inputSchema = z.object({
  cwd: z.string().min(1), expectedCwd: z.string().min(1).optional(),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  message: z.array(z.string()).optional(),
}).strict();
export { resultSchema };
export const config = {
  description: 'Start a new Codex thread in --cwd, optionally with --model, --effort and a message.',
  exitCode: 'result', positionals: ['message'],
  inputJsonSchema: { type: 'object', additionalProperties: false, properties: {
    cwd: { type: 'string' }, expectedCwd: { type: 'string' }, model: { type: 'string' },
    effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
    message: { type: 'array', items: { type: 'string' } },
  }, required: ['cwd'] },
} satisfies CliRouteConfig;
export default async function route({ input, signal }: CliRouteProps<typeof inputSchema>) {
  let out;
  try { out = await startCodexThread({ ...input, message: input.message?.join(' ').trim() || undefined, signal }); }
  catch (error) { out = outcomeFromError(error); }
  return <Agent.Result value={out}><Agent.Text>{out.threadId && !('delivery' in out) ? `Started Codex thread ${out.threadId}` : resultText(out)}</Agent.Text></Agent.Result>;
}
