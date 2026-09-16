import { StringDecoder } from "node:string_decoder";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { relayLocation } from "./profile.js";
export const RELAY_PROTOCOL = 1;
export const CONTROL_BYTES = 1024 * 1024;
export const CONTROL_TIMEOUT = 45000;
export function relayRequest(
  options,
  method,
  input = {},
  { timeoutMs = CONTROL_TIMEOUT, signal, requestId = randomUUID() } = {},
) {
  const { socketPath, profile } = relayLocation(options);
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "",
      bytes = 0,
      settled = false,
      connected = false;
    const socket = connect(socketPath);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const uncertain = () =>
      Object.assign(
        Error(
          `Relay control connection lost; do not resend with a new requestId (${requestId}). Check bridge status.`,
        ),
        { requestId },
      );
    const abort = () => finish(uncertain());
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    socket.on("error", (error) => finish(connected ? uncertain() : error));
    socket.on("close", () => finish(uncertain()));
    socket.on("connect", () => {
      connected = true;
      const line =
        JSON.stringify({
          version: RELAY_PROTOCOL,
          profile,
          requestId,
          method,
          input,
        }) + "\n";
      if (Buffer.byteLength(line) > CONTROL_BYTES)
        return finish(Error("Relay control request exceeds budget"));
      socket.write(line);
    });
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > CONTROL_BYTES)
        return finish(Error("Relay control response exceeds budget"));
      buffer += decoder.write(chunk);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        if (reply.version !== RELAY_PROTOCOL || reply.requestId !== requestId)
          throw Error("Relay protocol identity mismatch");
        if (reply.error) throw Error(reply.error);
        if (reply.profile !== profile) throw Error("Relay profile mismatch");
        finish(null, reply.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}
