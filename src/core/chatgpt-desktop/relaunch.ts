import { spawnSync } from 'node:child_process';

import { DEFAULT_CDP_PORT, resolveCdpPort } from './loopback.js';

export const CHATGPT_APP_PATH = '/Applications/ChatGPT.app';
export const CHATGPT_BUNDLE_ID = 'com.openai.codex';

/**
 * Shell command that quits ChatGPT Desktop and relaunches it with a local
 * Chromium `--remote-debugging-port`. Electron fuses block Node inspect /
 * RunAsNode, but not this Chromium flag. The port binds to 127.0.0.1 only.
 * Do not depend on `@electron/fuses read` — the framework is renamed
 * (`Codex Framework.framework`) and that tool fails.
 */
export function chatgptDesktopRelaunchCommand({
  port = DEFAULT_CDP_PORT,
  appPath = CHATGPT_APP_PATH,
}: {
  port?: number;
  appPath?: string;
} = {}): string {
  const resolved = resolveCdpPort(process.env, port);
  // Match explored launch: quit, then `open -a … --args --remote-debugging-port=N`.
  return [
    `osascript -e 'tell application "ChatGPT" to quit'`,
    `open -a ${shellQuote(appPath)} --args --remote-debugging-port=${resolved}`,
  ].join(' && ');
}

export function chatgptDesktopRelaunchArgs(port = DEFAULT_CDP_PORT): string[] {
  return ['--remote-debugging-port=' + resolveCdpPort(process.env, port)];
}

/**
 * Best-effort macOS relaunch. Returns the command that was (or would be) run.
 * Non-darwin platforms return `{ ran: false }` with the command for operators.
 */
export function relaunchChatGptDesktopWithCdp({
  port = DEFAULT_CDP_PORT,
  appPath = CHATGPT_APP_PATH,
  dryRun = false,
  runner = spawnSync,
}: {
  port?: number;
  appPath?: string;
  dryRun?: boolean;
  runner?: typeof spawnSync;
} = {}): {
  command: string;
  ran: boolean;
  platform: string;
  port: number;
  stdout?: string;
  stderr?: string;
  status?: number | null;
} {
  const resolved = resolveCdpPort(process.env, port);
  const command = chatgptDesktopRelaunchCommand({ port: resolved, appPath });
  if (dryRun || process.platform !== 'darwin') {
    return { command, ran: false, platform: process.platform, port: resolved };
  }
  const result = runner('bash', ['-lc', command], { encoding: 'utf8' });
  return {
    command,
    ran: true,
    platform: process.platform,
    port: resolved,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
