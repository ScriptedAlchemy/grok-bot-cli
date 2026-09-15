import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// Method and param names below come from `codex app-server generate-json-schema`
// of this Codex release. Newer daemons usually keep them; `gbot codex status`
// reports the running daemon's version next to this one.
export const PINNED_CODEX_VERSION = "0.154.0";
export const UPSTREAM_DESKTOP_ISSUES = [
  "https://github.com/openai/codex/issues/41014",
  "https://github.com/openai/codex/issues/41112",
];

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// Transport budgets: fail fast instead of buffering unbounded attacker-controlled bytes.
// ponytail: raise these only with streaming/pagination support; the app-server sends small JSON-RPC frames.
export const WS_MAX_HEADER_BYTES = 16 * 1024;
export const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const WS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const pkg = createRequire(import.meta.url)("../package.json");

export function codexSocketPath(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  return join(home, "app-server-control", "app-server-control.sock");
}

export function socketPresent(path) {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

export function unreachableMessage(path) {
  return [
    "No Codex app-server control socket at " + path + ".",
    "Either no daemon is running (start one with `codex app-server daemon start`),",
    "or ChatGPT Desktop is running a private stdio app-server that external clients cannot reach",
    "(" + UPSTREAM_DESKTOP_ISSUES.join(", ") + ").",
    "gbot codex targets daemon-managed threads only.",
  ].join("\n");
}

export function windowsUnsupportedMessage() {
  return [
    "gbot codex does not support native Windows yet.",
    "Codex's control socket is AF_UNIX; this CLI's Node client only dials Unix domain sockets.",
    "Use WSL, Linux, or macOS (or a future stdio proxy path).",
  ].join("\n");
}

export function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  const head = Buffer.alloc(len < 126 ? 2 : len < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([head, payload]);
  head[1] |= 0x80;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { fin, opcode, masked, payload, rest: buf.subarray(offset + len) };
}

/** Claimed frame length without consuming; null when the length prefix is incomplete. */
function peekFrameLength(buf) {
  if (buf.length < 2) return null;
  const marker = buf[1] & 0x7f;
  if (marker < 126) return marker;
  if (marker === 126) {
    if (buf.length < 4) return null;
    return buf.readUInt16BE(2);
  }
  if (buf.length < 10) return null;
  const big = buf.readBigUInt64BE(2);
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(big);
}

function validateUpgradeHead(head, key) {
  const lines = head.split("\r\n");
  if (!/^HTTP\/1\.1 101/.test(lines[0])) return false;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i === -1) return false;
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers.get("sec-websocket-accept") === websocketAccept(key)
    && (headers.get("upgrade") || "").toLowerCase() === "websocket"
    && (headers.get("connection") || "").toLowerCase().includes("upgrade");
}

function upgradeRequest(key) {
  return "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
}

export function websocketAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

export class CodexRpcError extends Error {
  constructor(method, error) {
    super("Codex app-server rejected " + method + ": " + (error && error.message ? error.message : JSON.stringify(error)));
    this.name = "CodexRpcError";
    this.method = method;
    this.rpc = error;
  }
}

export class CodexSendError extends Error {
  constructor(message, { delivery, threadId, turnId, refused } = {}) {
    super(message);
    this.name = "CodexSendError";
    this.delivery = delivery;
    if (threadId !== undefined) this.threadId = threadId;
    if (turnId !== undefined) this.turnId = turnId;
    if (refused !== undefined) this.refused = refused;
  }
}

/**
 * Open a JSON-RPC session to the app-server over its Unix socket (WebSocket framing).
 * Server-initiated requests (approvals, user input) are refused with a JSON-RPC error
 * and recorded in `refused`; gbot never approves on the user's behalf.
 */
export function connectCodexAppServer(path, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const key = randomBytes(16).toString("base64");
    const pending = new Map();
    const refused = [];
    let nextId = 1;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    let fragOpcode = null;
    let fragParts = [];
    let fragBytes = 0;

    const failAll = (err) => {
      if (closed) return;
      closed = true;
      if (err && err.delivery == null) err.delivery = pending.size ? "unknown" : "rejected";
      for (const { reject: rej } of pending.values()) rej(err);
      pending.clear();
      try { socket.destroy(); } catch { /* already gone */ }
      reject(err);
    };
    const failProtocol = (detail) => failAll(new Error("Codex app-server violated the WebSocket protocol: " + detail));
    const write = (opcode, payload) => {
      if (!socket.destroyed) socket.write(encodeFrame(opcode, payload, randomBytes(4)));
    };
    const sendJson = (obj) => write(0x1, Buffer.from(JSON.stringify(obj)));

    const client = {
      refused,
      request(method, params) {
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error("Codex app-server did not answer " + method + " within " + timeoutMs + "ms"));
          }, timeoutMs);
          pending.set(id, {
            method,
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          sendJson({ jsonrpc: "2.0", id, method, params });
        });
      },
      notify(method, params) {
        sendJson({ jsonrpc: "2.0", method, params });
      },
      close() {
        if (closed) return;
        closed = true;
        const err = new Error("Codex client closed");
        err.delivery = pending.size ? "unknown" : "rejected";
        for (const { reject: rej } of pending.values()) rej(err);
        pending.clear();
        if (!socket.destroyed) {
          if (upgraded) write(0x8, Buffer.from([0x03, 0xe8]));
          socket.end();
          socket.unref();
        }
      },
    };

    const onMessage = (msg) => {
      if (msg.id != null && msg.method) {
        refused.push({ id: msg.id, method: msg.method, params: msg.params });
        sendJson({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "gbot codex does not answer " + msg.method + "; configure approval_policy on the daemon" },
        });
        return;
      }
      if (msg.id == null || !pending.has(msg.id)) return;
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new CodexRpcError(entry.method, msg.error));
      else entry.resolve(msg.result);
    };

    const onText = (payload) => {
      let text;
      try {
        text = textDecoder.decode(payload);
      } catch {
        failAll(new Error("Codex app-server sent a non-UTF-8 text message"));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        failAll(new Error("Codex app-server sent an unreadable message: " + err.message));
        return;
      }
      onMessage(msg);
    };

    socket.setTimeout(timeoutMs, () => failAll(new Error("Timed out connecting to Codex app-server at " + path)));
    socket.once("error", (err) => failAll(new Error("Could not connect to Codex app-server at " + path + ": " + err.message)));
    socket.once("close", () => failAll(new Error("Codex app-server closed the connection")));
    socket.once("connect", () => socket.write(upgradeRequest(key)));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buf.length > WS_MAX_HEADER_BYTES) failAll(new Error("Codex app-server handshake headers exceed " + WS_MAX_HEADER_BYTES + " bytes"));
          return;
        }
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!validateUpgradeHead(head, key)) return failAll(new Error("Codex app-server refused the WebSocket upgrade: " + head.split("\r\n")[0]));
        upgraded = true;
        socket.setTimeout(0);
        resolve(client);
      }
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) {
          const claimed = peekFrameLength(buf);
          if (claimed != null && claimed > WS_MAX_MESSAGE_BYTES) {
            failAll(new Error("Codex app-server frame exceeds " + WS_MAX_MESSAGE_BYTES + " bytes"));
          } else if (buf.length > WS_MAX_BUFFER_BYTES) {
            failAll(new Error("Codex app-server buffer exceeds " + WS_MAX_BUFFER_BYTES + " bytes"));
          }
          return;
        }
        buf = frame.rest;
        if (frame.masked) return failProtocol("server frames must not be masked");
        if (frame.opcode >= 0x8) {
          if (!frame.fin || frame.payload.length > 125) return failProtocol("bad control frame");
          if (frame.opcode === 0x9) write(0xa, frame.payload);
          else if (frame.opcode === 0x8) {
            write(0x8, frame.payload);
            socket.end();
            failAll(new Error("Codex app-server closed the connection"));
          }
          continue; // pong and other control frames carry nothing for us
        }
        if (frame.opcode === 0x0) {
          if (fragOpcode == null) return failProtocol("continuation with nothing to continue");
          fragParts.push(frame.payload);
          fragBytes += frame.payload.length;
          if (fragBytes > WS_MAX_MESSAGE_BYTES) return failAll(new Error("Codex app-server message exceeds " + WS_MAX_MESSAGE_BYTES + " bytes"));
          if (!frame.fin) continue;
          const whole = Buffer.concat(fragParts, fragBytes);
          const opcode = fragOpcode;
          fragOpcode = null;
          fragParts = [];
          fragBytes = 0;
          // ponytail: binary frames are unused by the app-server; only text is delivered.
          if (opcode === 0x1) onText(whole);
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          if (fragOpcode != null) return failProtocol("new message before finishing fragments");
          if (!frame.fin) {
            fragOpcode = frame.opcode;
            fragParts = [frame.payload];
            fragBytes = frame.payload.length;
            continue;
          }
          // ponytail: binary frames are unused by the app-server; only text is delivered.
          if (frame.opcode === 0x1) onText(frame.payload);
          continue;
        }
        return failProtocol("unknown opcode " + frame.opcode);
      }
    });
  });
}

function appServerVersion(initResult) {
  const ua = initResult && typeof initResult.userAgent === "string" ? initResult.userAgent : "";
  const m = /^[^/\s]+\/(\S+)/.exec(ua);
  return m ? m[1] : null;
}

async function openSession(env = process.env) {
  if (process.platform === "win32") throw new Error(windowsUnsupportedMessage());
  const path = codexSocketPath(env);
  if (!socketPresent(path)) throw new Error(unreachableMessage(path));
  const client = await connectCodexAppServer(path);
  let init;
  try {
    init = await client.request("initialize", { clientInfo: { name: "gbot", version: pkg.version } });
  } catch (err) {
    client.close();
    throw err;
  }
  client.notify("initialized");
  return { client, path, init };
}

export function localCodexVersion() {
  const out = spawnSync("codex", ["--version"], { encoding: "utf8" });
  const m = out.status === 0 ? /(\d+\.\d+\.\d+\S*)/.exec(out.stdout) : null;
  return m ? m[1] : null;
}

export async function codexStatus(env = process.env) {
  const path = codexSocketPath(env);
  const base = { socketPath: path, pinnedVersion: PINNED_CODEX_VERSION, cliVersion: localCodexVersion() };
  if (process.platform === "win32") {
    return { ...base, reachable: false, mode: "windows-unsupported", message: windowsUnsupportedMessage() };
  }
  if (!socketPresent(path)) {
    return { ...base, reachable: false, mode: "socket-absent", message: unreachableMessage(path) };
  }
  const { client, init } = await openSession(env);
  client.close();
  const daemonVersion = appServerVersion(init);
  return {
    ...base,
    reachable: true,
    mode: "daemon",
    daemonVersion,
    codexHome: init.codexHome ?? null,
    versionMismatch: Boolean(base.cliVersion && daemonVersion && base.cliVersion !== daemonVersion),
  };
}

export function summarizeThread(t) {
  return {
    id: t.id,
    status: t.status && t.status.type ? t.status.type : "unknown",
    name: t.name ?? null,
    preview: t.preview ?? "",
    cwd: t.cwd ?? null,
    source: t.source ?? null,
    updatedAt: t.updatedAt ?? null,
  };
}

export async function listCodexThreads({ limit = 20, env = process.env } = {}) {
  const { client } = await openSession(env);
  try {
    // The default listing rescans every rollout file to repair metadata (26 s on a busy machine);
    // the state DB already holds what we print.
    const out = await client.request("thread/list", { limit, useStateDbOnly: true });
    return { threads: out.data.map(summarizeThread), nextCursor: out.nextCursor ?? null };
  } finally {
    client.close();
  }
}

function explainSendError(err, threadId) {
  if (!(err instanceof CodexRpcError)) return err;
  const msg = String(err.rpc && err.rpc.message || "");
  if (/no rollout found|thread not found/i.test(msg)) {
    return new Error("Unknown Codex thread " + threadId + ". Run `gbot codex list-threads` to see reachable threads.");
  }
  if (/active writer/i.test(msg)) {
    return new Error("Codex thread " + threadId + " is open in another client (VS Code, TUI, or Desktop), which owns its turns. Close it there first.");
  }
  return err;
}

export async function sendToCodexThread(threadId, text, env = process.env) {
  const { client } = await openSession(env);
  try {
    let resumed;
    try {
      resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
    } catch (err) {
      if (err instanceof CodexSendError) throw err;
      throw new CodexSendError(explainSendError(err, threadId).message, {
        delivery: err instanceof CodexRpcError ? "rejected" : (err && err.delivery) || "unknown",
        threadId,
      });
    }
    // Scope refusals to this turn: server requests from earlier calls belong to another context.
    const seenRefused = client.refused.length;
    let turn;
    try {
      turn = await client.request("turn/start", { threadId, input: [{ type: "text", text }] });
    } catch (err) {
      if (err instanceof CodexSendError) throw err;
      const delivery = err instanceof CodexRpcError ? "rejected" : (err && err.delivery) || "unknown";
      const detail = err instanceof CodexRpcError
        ? err.message
        : "Lost the Codex turn/start response for thread " + threadId + ": " + ((err && err.message) || err)
          + ". Delivery is unknown; check the thread before resending.";
      // ponytail: no blind retry here; a stable receipt/correlation envelope is issue #37.
      throw new CodexSendError(detail, { delivery, threadId });
    }
    const turnId = turn && turn.turn && typeof turn.turn.id === "string" && turn.turn.id ? turn.turn.id : null;
    if (!turnId) {
      throw new CodexSendError(
        "Codex app-server sent a malformed turn/start acknowledgment for thread " + threadId + ". Delivery is unknown; check the thread before resending.",
        { delivery: "unknown", threadId },
      );
    }
    const freshRefused = client.refused.slice(seenRefused)
      .filter((r) => !r.params || r.params.threadId == null || r.params.threadId === threadId);
    if (freshRefused.length) {
      const methods = freshRefused.map((r) => r.method).join(", ");
      throw new CodexSendError(
        "Turn " + turnId + " started on thread " + threadId + " but Codex asked for " + methods + ", which gbot refused. "
        + "Answer it in a Codex client, or set `approval_policy = \"never\"` in the daemon's config.toml for unattended sends.",
        { delivery: "accepted", threadId, turnId, refused: freshRefused.map((r) => r.method) },
      );
    }
    return {
      delivery: "accepted",
      threadId: resumed.thread.id,
      turnId,
      turnStatus: turn.turn.status,
      model: resumed.model,
      cwd: resumed.cwd,
      approvalPolicy: resumed.approvalPolicy,
    };
  } finally {
    client.close();
  }
}
