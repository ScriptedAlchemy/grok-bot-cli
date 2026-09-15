import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { codexStatus } from '../../core/codex-bridge.js';
import { formatCodexStatus } from '../../core/format.js';

export const config = {
  description: 'Probe the local Codex app-server daemon. Exit 0 only when it is usable.',
  exitCode: 'result',
  inputJsonSchema: { additionalProperties: false, properties: {}, type: 'object' },
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();
export const resultSchema = z
  .object({
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .passthrough();

export default async function codexStatusCmd(_props: CliRouteProps<typeof inputSchema>) {
  const status = await codexStatus();
  return (
    <Agent.Result value={status}>
      <Agent.Text>{formatCodexStatus(status)}</Agent.Text>
    </Agent.Result>
  );
}
