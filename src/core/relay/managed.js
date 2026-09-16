import { spawn } from "node:child_process";
import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { digest, relayLocation } from "./profile.js";
import { relayRequest } from "./control.js";

/** @param {{pluginRoot?: string, moduleUrl?: string}} options */
export async function resolveRelayWorker({
  pluginRoot,
  moduleUrl = import.meta.url,
} = {}) {
  const roots = [];
  if (pluginRoot) roots.push(pluginRoot);
  let path = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 5; i++) {
    roots.push(path);
    path = dirname(path);
  }
  for (const candidate of new Set(roots)) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(candidate, "agent-bundle.manifest.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const relative = "scripts/gbot-relay.mjs";
    const file = manifest.files?.find((f) => f.path === relative);
    if (
      manifest.application?.name !== "gbot" ||
      !file ||
      !manifest.executables?.scripts?.some((s) => s.path === relative)
    )
      continue;
    const root = await realpath(candidate),
      worker = join(root, relative),
      stat = await lstat(worker);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(worker)) !== worker
    )
      throw Error("Relay worker must be a regular packaged script");
    if (
      stat.size !== file.bytes ||
      digest(await readFile(worker)) !== file.sha256
    )
      throw Error("Packaged relay worker checksum mismatch");
    return worker;
  }
  throw Error(
    "Packaged relay worker not found; rebuild or reinstall the plugin",
  );
}
const unavailable = (error) => ["ENOENT", "ECONNREFUSED"].includes(error.code);
export async function ensureRelayWorker(options = {}) {
  const location = relayLocation(options);
  try {
    return await relayRequest(location, "hello", {}, { timeoutMs: 1500 });
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
  const workerPath = await resolveRelayWorker(options);
  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: "ignore",
    env: { ...location.env, GROK_BOT_RELAY_DIR: location.stateDir },
    cwd: dirname(workerPath),
  });
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.unref();
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (spawnError) throw spawnError;
    if (options.signal?.aborted)
      throw Error("Relay startup cancelled before submission");
    try {
      return await relayRequest(
        location,
        "hello",
        {},
        { timeoutMs: 1000, signal: options.signal },
      );
    } catch (error) {
      if (!unavailable(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw Error(
    "Relay worker startup failed or timed out; no untracked send was attempted. Inspect bridge status and the relay owner lock.",
  );
}
export async function managedOperation(method, input, options = {}) {
  const location = relayLocation(options);
  const requestId = input.requestId ?? randomUUID();
  if (!["status", "stop", "respond"].includes(method))
    await ensureRelayWorker(options);
  try {
    return await relayRequest(location, method, input, {
      signal: options.signal,
      requestId,
    });
  } catch (error) {
    if (method === "status" && unavailable(error))
      return {
        worker: {
          state: "stopped",
          profile: location.profile,
          supervised: false,
        },
        reason:
          "Worker is not running. Start a route or tracked send to resume saved routes.",
      };
    // Never retry a disconnected mutation. Its durable request ID is the recovery handle.
    throw error;
  }
}
