/**
 * Shared agent-facing guidance: Codex/Claude live on the user's registered
 * machines. gbot has no remote transport — only a local Unix socket.
 */
export const USER_MACHINE_CODEX_CLAUDE_GUIDANCE = [
  "Codex and Claude sessions live on the user's registered machines (for example their Linux desktop or Mac), not on the Grok Bot agent box (/home/box).",
  "Codex must run on the same machine as gbot. Set CODEX_APP_SERVER_SOCK to an existing local control socket, or use $CODEX_HOME/app-server-control/app-server-control.sock. There is no remote transport.",
  "When running on the box (HOME=/home/box), do not call codex_* or claude_send there. Run the gbot CLI on the user's machine through Grok Bot Shell with a machineId (the host's machine-targeted shell).",
  "On that machine, provide the socket with `codex app-server daemon start` (or bootstrap). Auth stays with each machine's native Codex or Claude login; gbot does not store or export credentials.",
].join("\n");

/**
 * True when this process is (or is resolving sockets under) the Grok Bot agent
 * sandbox. Prefer HOME=/home/box; also treat paths under /home/box as box-like.
 */
export function looksLikeGrokBotBox({ path = "", env = process.env, home = env.HOME || "" } = {}) {
  const values = [home, env.HOME, path]
    .filter((value) => value != null && value !== "")
    .map(String);
  return values.some((value) => value === "/home/box" || value.startsWith("/home/box/"));
}
