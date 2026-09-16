import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Enumerate tests portably without relying on shell glob expansion.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test");
// Codex routes throw windows-unsupported before connecting, and these suites
// also assume Unix sockets, /tmp, shebang binaries, or process.getuid().
// Portable suites still run so Package CI can pass on windows-latest.
const skipOnWindows = new Set([
  "test/codex-bridge.test.js",
  "test/codex-conversation.test.js",
  "test/codex-session.test.js",
  "test/codex-surfaces.test.js",
  "test/relay-auth-recovery.test.js",
  "test/relay-engine.test.js",
  "test/relay-gateway-lifecycle.test.js",
  "test/relay-lifecycle.test.js",
  "test/relay-surfaces.test.js",
  "test/relay-worker.test.js",
]);
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name))
  .filter((name) => {
    if (process.platform === "win32" && skipOnWindows.has(name)) {
      console.error(`skip ${name}: Unix sockets and Codex routes are unsupported on win32`);
      return false;
    }
    return true;
  });
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  // Loopback-only credential URLs (src/core/url-policy.js testMode): a test can never reach a live gateway.
  env: { ...process.env, GROK_BOT_TEST: "1" },
  stdio: "inherit",
});
process.exit(result.status === null ? 1 : result.status);
