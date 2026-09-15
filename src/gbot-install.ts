import { fileURLToPath } from 'node:url';

import { runInstallCli } from 'agent-bundle/install';

/**
 * `gbot-install install|uninstall <host>` and `gbot-install doctor`, bound to the
 * emitted npm `dist/` root that holds the Claude, Codex, and Cursor projections.
 */
export const main = (argv: readonly string[]): Promise<number> =>
  runInstallCli(argv, {
    from: fileURLToPath(new URL('..', import.meta.url)),
    name: 'gbot-install',
  });
