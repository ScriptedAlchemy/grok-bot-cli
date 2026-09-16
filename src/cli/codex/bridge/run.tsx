import { Agent, agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveRelayWorker } from '../../../core/relay/managed.js';
export const inputSchema = z
  .object({
    lifetimeMs: z.number().int().min(100).max(82800000).default(82800000),
  })
  .strict();
export const resultSchema = z.object({
  state: z.string(),
  exitCode: z.number(),
});
export const config = {
  description:
    'Run a bounded foreground relay (up to 23 hours). Use the packaged gbot-relay.mjs script for unlimited service lifetime.',
  exitCode: 'result',
  render: { maxElapsedMs: 86400000 },
  inputJsonSchema: {
    type: 'object',
    properties: {
      lifetimeMs: {
        type: 'number',
        description:
          'Foreground lifetime in milliseconds (100..82800000; default 23h).',
      },
    },
    additionalProperties: false,
  },
} satisfies CliRouteConfig;
export default async function route({
  signal,
  input,
}: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const script = await resolveRelayWorker({
    pluginRoot:
      context.plugin.state === 'available'
        ? context.plugin.value.root
        : undefined,
  });
  // The renderer may terminate immediately on abort. The separate worker can finish
  // asynchronous socket/ledger cleanup after the synchronous termination signal.
  const child = spawn(
    process.execPath,
    [
      script,
      '--lifetime-ms',
      String(input.lifetimeMs),
      '--parent-pid',
      String(process.pid),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const stop = () => {
    child.kill('SIGTERM');
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  let exitCode;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    signal.removeEventListener('abort', stop);
  }
  return (
    <Agent.Result value={{ state: 'stopped', exitCode }}>
      <Agent.Text>Relay worker stopped.</Agent.Text>
    </Agent.Result>
  );
}
