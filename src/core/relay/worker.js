import { StringDecoder } from "node:string_decoder";
import { createServer } from "node:net";
import { chmod, unlink, realpath } from "node:fs/promises";
import { openRelayEngine } from "./engine.js";
import { relayLocation } from "./profile.js";
import { claimRelayOwner } from "./ownership.js";
import { CONTROL_BYTES, CONTROL_TIMEOUT, RELAY_PROTOCOL } from "./control.js";
import { redactSecrets } from "../url-policy.js";

export async function runRelayWorker(options = {}) {
  const location = relayLocation(options);
  const release = await claimRelayOwner(location);
  let engine,
    server,
    timer,
    closing = false,
    inFlight = 0,
    ownsSocket = false;
  const clients = new Set();
  let done;
  const closed = new Promise((resolve) => {
    done = resolve;
  });
  async function close() {
    if (closing) return closed;
    closing = true;
    clearTimeout(timer);
    for (const s of clients) s.destroy();
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    await engine?.close();
    if (ownsSocket) await unlink(location.socketPath).catch(() => {});
    await release();
    done();
  }
  try {
    engine = await (options.openEngine ?? openRelayEngine)({
      stateDir: location.stateDir,
      profile: location.profile,
      env: location.env,
    });
    const health = () => ({
      state: closing ? "stopped" : "running",
      pid: process.pid,
      protocol: RELAY_PROTOCOL,
      profile: location.profile,
      supervised: false,
    });
    async function dispatch(request) {
      if (request.version !== RELAY_PROTOCOL)
        throw Error("Relay protocol mismatch");
      if (request.profile !== location.profile)
        throw Error("Relay profile mismatch");
      if (
        typeof request.requestId !== "string" ||
        request.requestId.length < 1 ||
        request.requestId.length > 128
      )
        throw Error("Invalid relay request identity");
      const input = request.input;
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("Invalid relay input");
      switch (request.method) {
        case "hello":
          return { worker: health() };
        case "status":
          return { ...engine.status(input), worker: health() };
        case "startBinding":
          return {
            binding: await engine.startBinding({
              ...input,
              requestId: request.requestId,
            }),
            worker: health(),
          };
        case "sendToGrok":
        case "sendToCodex":
          if (input.bindingId) {
            const binding = engine.status({ bindingId: input.bindingId })
              .bindings[0];
            if (input.codexThreadId && input.codexThreadId !== binding.threadId)
              throw Error("Binding belongs to a different Codex thread");
            if (
              input.expectedCwd &&
              (await realpath(input.expectedCwd)) !== binding.expectedCwd
            )
              throw Error("Binding workspace does not match expectedCwd");
          }
          return {
            ...(await engine[request.method]({
              ...input,
              requestId: request.requestId,
            })),
            controlRequestId: request.requestId,
            worker: health(),
          };
        case "stop": {
          if (!input.bindingId && input.all !== true && input.worker !== true)
            throw Error("Stop requires bindingId, all or worker");
          if (input.all)
            for (const binding of engine.status().bindings)
              await engine.stopBinding({ bindingId: binding.id });
          else if (input.bindingId)
            await engine.stopBinding({ bindingId: input.bindingId });
          const result = {
            ...engine.status(),
            worker: {
              ...health(),
              state: input.worker ? "stopping" : "running",
            },
          };
          return result;
        }
        case "respond":
          return await engine.respond(input);
        default:
          throw Error("Unknown relay control method");
      }
    }
    server = createServer((socket) => {
      if (clients.size >= 32 || inFlight >= 32) {
        socket.destroy();
        return;
      }
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(CONTROL_TIMEOUT, () => socket.destroy());
      const decoder = new StringDecoder("utf8");
      let buffer = "",
        bytes = 0,
        received = false;
      socket.on("data", async (chunk) => {
        if (received) return;
        bytes += chunk.length;
        if (bytes > CONTROL_BYTES) {
          socket.destroy();
          return;
        }
        buffer += decoder.write(chunk);
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        received = true;
        inFlight++;
        let request;
        let reply;
        try {
          request = JSON.parse(buffer.slice(0, end));
          reply = { result: await dispatch(request) };
        } catch (error) {
          reply = {
            error: redactSecrets(String(error.message)).slice(0, 2048),
          };
        }
        const out =
          JSON.stringify({
            version: RELAY_PROTOCOL,
            profile: location.profile,
            requestId: request?.requestId,
            ...reply,
          }) + "\n";
        if (Buffer.byteLength(out) > CONTROL_BYTES)
          socket.end(
            JSON.stringify({
              version: RELAY_PROTOCOL,
              profile: location.profile,
              requestId: request?.requestId,
              error:
                "Relay status exceeds control budget; narrow bindingId or limit",
            }) + "\n",
          );
        else socket.end(out);
        inFlight--;
        if (!reply.error && request.method === "stop" && request.input.worker)
          setImmediate(() => void close());
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(location.socketPath, () => {
        ownsSocket = true;
        resolve();
      });
    });
    await chmod(location.socketPath, 0o600);
    async function tick() {
      try {
        await engine.tick();
      } catch {
        /* Engine status retains bounded failure state. */
      }
      if (!closing) timer = setTimeout(tick, 2000);
    }
    timer = setTimeout(tick, 2000);
    return { close, closed, location };
  } catch (error) {
    await close();
    throw error;
  }
}
