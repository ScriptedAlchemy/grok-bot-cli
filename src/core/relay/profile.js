import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { codexSocketPath } from "../codex-bridge.js";
import { grokBotGatewayDescriptorPath } from "../app-session.js";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
// Only explicit overrides are hashed. App-session token refresh retains its source identity.
export function relayProfile(env = process.env) {
  const keys = [
    "GROK_BOT_GATEWAY_URL",
    "SAND_HOST_GATEWAY_URL",
    "SAND_HOST_PORT",
    "GROK_BOT_GATEWAY_TOKEN",
    "SAND_HOST_GATEWAY_TOKEN",
    "SAND_GATEWAY_TOKEN",
    "CURSOR_ACCESS_TOKEN",
    "GROK_BOT_ACCESS_TOKEN",
    "SAND_ACCESS_TOKEN",
    "GROK_BOT_GATEWAY_HEADERS",
    "SAND_BACKEND_URL",
    "CURSOR_API_BASE_URL",
    "SAND_BOX_NAMESPACE",
    "SAND_CLIENT_VERSION",
    "GROK_BOT_CODEX_THREADS",
    "GROK_BOT_MAX_HOPS",
    "GROK_BOT_CODEX_EXPERIMENTAL",
    "GROK_BOT_ALLOW_LOCAL_GATEWAY",
    "GROK_BOT_ALLOW_ANY_GATEWAY",
    "GROK_BOT_TEST",
    "NODE_ENV",
  ];
  return digest(
    JSON.stringify([
      resolve(codexSocketPath(env)),
      grokBotGatewayDescriptorPath(homedir(), process.platform, env),
      ...keys.map((key) => [key, env[key] ?? ""]),
    ]),
  );
}
export function relayLocation({
  env = process.env,
  stateDir,
  profile = relayProfile(env),
} = {}) {
  if (process.platform === "win32")
    throw Error(
      "Codex relay requires Unix-domain sockets; Windows is unsupported.",
    );
  const dir = resolve(
    stateDir ??
      env.GROK_BOT_RELAY_DIR ??
      join(homedir(), ".grok-bot-cli", "relay", profile.slice(0, 24)),
  );
  // macOS Unix sockets cannot use arbitrarily long installation/state paths.
  const socketDir =
    Buffer.byteLength(join(dir, "control.sock")) < 100
      ? dir
      : join(
          "/tmp",
          `gbot-relay-${process.getuid()}`,
          digest(dir).slice(0, 24),
        );
  return {
    stateDir: dir,
    profile,
    env,
    socketDir,
    socketPath: join(socketDir, "control.sock"),
  };
}
