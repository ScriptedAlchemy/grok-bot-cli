import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame, encodeFrame, websocketAccept } from "../../src/core/codex-bridge.js";
export async function fakeAppServer(handlers) {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const received = [];
  const sockets = new Set();
  let resolveDisconnected;
  const disconnected = new Promise((resolve) => { resolveDisconnected = resolve; });
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      resolveDisconnected();
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Accept: " + websocketAccept(req.headers["sec-websocket-key"]) + "\r\n\r\n",
    );
    const send = (obj) => socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) return;
        buf = frame.rest;
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode !== 0x1) continue;
        const msg = JSON.parse(frame.payload.toString());
        received.push(msg);
        if (msg.method && msg.id != null) {
          const handler = handlers[msg.method];
          if (!handler) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
          else handler(msg.params, (result) => send({ jsonrpc: "2.0", id: msg.id, result }), (error) => send({ jsonrpc: "2.0", id: msg.id, error }), send, socket);
        }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    home,
    received,
    disconnected,
    close: () => new Promise((resolve) => {
      for (const sock of sockets) sock.destroy();
      server.close(resolve);
    }),
  };
}
