import { fileURLToPath } from 'node:url';

import { runInstallCli } from 'agent-bundle/install';

/**
 * `gbot-install install|uninstall <host>` and `gbot-install doctor`, bound to the
 * emitted npm root (`plugin/dist` inside the `grok-bot-cli` tarball) that holds the
 * Claude, Codex, and Cursor projections of the grok-bot plugin.
 */
export const main = (argv: readonly string[]): Promise<number> =>
  runInstallCli(argv, {
    from: fileURLToPath(new URL('..', import.meta.url)),
    name: 'gbot-install',
  });
