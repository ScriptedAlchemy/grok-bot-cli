import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame, encodeFrame, websocketAccept } from "../../src/core/codex-bridge.js";
export function createCodexFixtureHome(prefix = "gbot-codex-") {
  // Darwin's sockaddr_un.sun_path holds 104 bytes including the NUL. Its
  // per-user TMPDIR is often too long; retain mkdtemp isolation in a short root.
  const candidate = join(tmpdir(), prefix + "XXXXXX", "app-server-control", "app-server-control.sock");
  const root = process.platform !== "win32" && Buffer.byteLength(candidate) >= 104 ? "/tmp" : tmpdir();
  return mkdtempSync(join(root, prefix));
}
export async function fakeAppServer(handlers) {
  const home = createCodexFixtureHome();
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
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  return {
    home,
    received,
    disconnected,
    close: () => new Promise((resolve) => {
      for (const sock of sockets) sock.destroy();
      server.close(() => { rmSync(home, { recursive: true, force: true }); resolve(); });
    }),
  };
}
