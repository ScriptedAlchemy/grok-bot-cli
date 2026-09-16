import { runRelayWorker } from "../core/relay/worker.js";

const args = process.argv.slice(2);
let lifetimeMs: number | undefined, parentPid: number | undefined;
for (let i = 0; i < args.length; i += 2) {
  const value = Number(args[i + 1]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw Error("Invalid relay worker argument");
  if (args[i] === "--lifetime-ms" && value <= 82800000) lifetimeMs = value;
  else if (args[i] === "--parent-pid") parentPid = value;
  else throw Error("Unknown relay worker argument");
}
if (parentPid !== undefined && process.ppid !== parentPid)
  throw Error("Foreground relay parent has exited");
const worker = await runRelayWorker();
const stop = () => {
  void worker.close();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
const lifetime =
  lifetimeMs === undefined ? undefined : setTimeout(stop, lifetimeMs);
// Only a bounded foreground CLI child follows its parent's lifetime. Managed
// workers and direct service-manager invocations are independent by default.
const parent =
  parentPid === undefined
    ? undefined
    : setInterval(() => {
        if (process.ppid !== parentPid) stop();
      }, 250);
await worker.closed;
clearTimeout(lifetime);
clearInterval(parent);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.removeListener(signal, stop);
