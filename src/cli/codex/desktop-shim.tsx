import { Agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { desktopShimStatus, installDesktopShim, uninstallDesktopShim } from '../../core/desktop-shim.js';
import { formatDesktopShimStatus } from '../../core/format.js';

export const config = {
  description:
    'Install, remove, or check the ChatGPT Desktop shim: a CODEX_CLI_PATH wrapper that bridges Desktop stdio onto the managed Codex daemon (stock app-server proxy hangs). macOS persists via LaunchAgent; always fails open to real Codex.',
  exitCode: 'result',
  inputJsonSchema: {
    additionalProperties: false,
    properties: {
      action: { description: 'install | uninstall | status', enum: ['install', 'uninstall', 'status'], type: 'string' },
    },
    required: ['action'],
    type: 'object',
  },
  positionals: ['action'],
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({ action: z.enum(['install', 'uninstall', 'status']) })
  .strict();
export const resultSchema = z
  .object({
    exitCode: z.union([z.literal(0), z.literal(1)]),
  })
  .passthrough();

const formatWarnings = (warnings: readonly unknown[]): string =>
  warnings.length === 0 ? '' : `\nwarnings:\n${warnings.map((w) => `  - ${String(w)}`).join('\n')}`;

export default async function codexDesktopShim({ input }: CliRouteProps<typeof inputSchema>) {
  switch (input.action) {
    case 'install': {
      let out;
      try {
        out = installDesktopShim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return (
          <Agent.Result value={{ action: 'install', error: message, exitCode: 1 as const }}>
            <Agent.Text>{`Desktop shim install failed: ${message}`}</Agent.Text>
          </Agent.Result>
        );
      }
      const text =
        `Installed ChatGPT Desktop shim:\n` +
        `  wrapper: ${out.wrapperPath}\n` +
        `  bridge: ${out.bridgePath}\n` +
        `  login env: ${out.envScriptPath}` +
        (out.plistPath ? `\n  LaunchAgent: ${out.plistPath}` : '\n  LaunchAgent: n/a (macOS-only)') +
        `\nFully quit and relaunch ChatGPT.app so it inherits CODEX_CLI_PATH; ` +
        `Desktop falls back to stock Codex if the shim is ever removed.` +
        formatWarnings(out.warnings);
      return (
        <Agent.Result value={out}>
          <Agent.Text>{text}</Agent.Text>
        </Agent.Result>
      );
    }
    case 'uninstall': {
      let out;
      try {
        out = uninstallDesktopShim();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return (
          <Agent.Result value={{ action: 'uninstall', error: message, exitCode: 1 as const }}>
            <Agent.Text>{`Desktop shim uninstall failed: ${message}`}</Agent.Text>
          </Agent.Result>
        );
      }
      const removed = out.removed.length === 0 ? '(nothing installed)' : out.removed.join(', ');
      const text =
        `Removed ChatGPT Desktop shim: ${removed}. ` +
        `Desktop and Codex fall back to stock behavior; relaunch ChatGPT.app to pick it up.` +
        formatWarnings(out.warnings);
      return (
        <Agent.Result value={out}>
          <Agent.Text>{text}</Agent.Text>
        </Agent.Result>
      );
    }
    case 'status': {
      const out = desktopShimStatus();
      return (
        <Agent.Result value={out}>
          <Agent.Text>{formatDesktopShimStatus(out)}</Agent.Text>
        </Agent.Result>
      );
    }
    default: {
      const _exhaustive: never = input.action;
      throw new Error(`unknown desktop-shim action: ${String(_exhaustive)}`);
    }
  }
}
