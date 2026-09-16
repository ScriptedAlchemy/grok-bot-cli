import { createHash, randomBytes, randomUUID } from "node:crypto";
import { statSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { outcomeFromError, outcomeFromReceipt, withStatusExitCode } from "./codex/contract.js";
import { desktopShimStatus } from "./desktop-shim.js";

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
export const WS_MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const CODEX_MAX_REQUESTS = 128;
export const CODEX_MAX_LISTENERS = 128;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const pkg = createRequire(import.meta.url)("../../package.json");

export function codexSocketPath(env = process.env) {
  // Explicit socket wins so status/send/queue agree with a shim-installed or
  // operator-exported CODEX_APP_SERVER_SOCK; otherwise derive from CODEX_HOME.
  if (env.CODEX_APP_SERVER_SOCK) return env.CODEX_APP_SERVER_SOCK;
  const home = env.CODEX_HOME || join(homedir(), ".codex");
  return join(home, "app-server-control", "app-server-control.sock");
}

/** `socket` | `absent` | `permission-denied` | `not-a-socket`; permission failures are not absence. */
export function socketState(path) {
  try {
    return statSync(path).isSocket() ? "socket" : "not-a-socket";
  } catch (err) {
    return err && (err.code === "EACCES" || err.code === "EPERM") ? "permission-denied" : "absent";
  }
}

/** Strip ANSI/OSC sequences and C0/C1 controls (tab and newline stay) from server-supplied text. */
export function stripTerminalControls(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** Single-line fields (ids, names, paths, cursors, header tokens): no line breaks or tabs survive. */
export function singleLine(text) {
  return stripTerminalControls(text).replace(/[\t\n\r\u2028\u2029]+/g, " ");
}

export function unreachableMessage(path, desktopAttached = "unknown") {
  if (desktopAttached === "private-stdio") {
    return [
      "ChatGPT Desktop is running its private stdio app-server, which external clients cannot reach",
      "(" + UPSTREAM_DESKTOP_ISSUES.join(", ") + ").",
      "No Codex app-server control socket at " + path + ": start a managed standalone daemon with `codex app-server daemon start`.",
      "gbot codex targets daemon-managed threads only.",
    ].join("\n");
  }
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
  constructor(message, { delivery, threadId, turnId, refused, reason, envelope } = {}) {
    super(message);
    this.name = "CodexSendError";
    this.delivery = delivery;
    if (reason !== undefined) this.reason = reason;
    if (threadId !== undefined) this.threadId = threadId;
    if (turnId !== undefined) this.turnId = turnId;
    if (refused !== undefined) this.refused = refused;
    if (envelope !== undefined) this.envelope = envelope;
  }
}

/** The route to the app-server is unavailable; `mode` is a stable machine-readable state. */
export class CodexRouteError extends Error {
  constructor(message, mode) {
    super(message);
    this.name = "CodexRouteError";
    this.mode = mode;
    this.delivery = "rejected";
    this.reason = mode;
  }
}

/** The app-server answered with a shape this pinned schema does not describe. */
export class CodexProtocolError extends Error {
  constructor(method, detail) {
    super("Codex app-server returned an unexpected " + method + " response: " + detail
      + ". gbot is pinned to app-server schema " + PINNED_CODEX_VERSION + "; run `gbot codex status --json` to compare versions.");
    this.name = "CodexProtocolError";
    this.method = method;
    this.mode = "bad-response";
    this.reason = "bad-response";
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Failures before the WebSocket upgrade completes: the socket is present but unusable. */
function connectError(err, path) {
  const code = err && err.cause && err.cause.code ? err.cause.code : err && err.code;
  const message = err && err.message ? err.message : String(err);
  if (code === "EACCES" || code === "EPERM" || /\bEACCES\b|\bEPERM\b/.test(message)) {
    return new CodexRouteError("Codex app-server control socket at " + path + " refused the connection for this user (" + code + "). "
      + "gbot runs as the user who owns CODEX_HOME; check the socket's owner and mode.", "permission-denied");
  }
  if (/refused the WebSocket upgrade|violated the WebSocket protocol|handshake headers exceed/.test(message)) {
    return new CodexRouteError(message, "handshake-failed");
  }
  return new CodexRouteError(message + " (socket present at " + path + ", but no app-server completed the connection).", "connect-failed");
}

/** Failures while initializing an upgraded connection: reachable transport, unusable session. */
function handshakeError(err) {
  if (err instanceof CodexProtocolError) return err;
  const message = err && err.message ? err.message : String(err);
  return new CodexRouteError("Codex app-server accepted the connection but initialize failed: " + message, "handshake-failed");
}

/** Failures after a session exists: the request may or may not have been processed. */
function transportError(err) {
  if (err instanceof CodexRpcError || err instanceof CodexProtocolError || err instanceof CodexSendError || err instanceof CodexRouteError) return err;
  if (err && typeof err === "object" && err.reason === undefined) err.reason = "transport";
  return err;
}

/**
 * Open a JSON-RPC session to the app-server over its Unix socket (WebSocket framing).
 * Server requests are observed without answering by default. Legacy one-shot
 * callers arm ownership-scoped refusals; persistent sessions respond explicitly.
 */
export function connectCodexAppServer(path, { timeoutMs = 15000, signal, onNotification, onServerRequest, onClose } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
      throw new RangeError("timeoutMs must be an integer 1-2147483647");
    }
    for (const listener of [onNotification, onServerRequest, onClose]) {
      if (listener !== undefined && typeof listener !== "function") throw new TypeError("Event listener must be a function");
    }
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
    if (signal?.aborted) throw new Error("Codex connection aborted", { cause: signal.reason });
    const socket = createConnection({ path });
    const key = randomBytes(16).toString("base64");
    const pending = new Map();
    const refused = [];
    const serverRequests = new Map();
    const listeners = {
      notification: new Set(onNotification ? [onNotification] : []),
      serverRequest: new Set(onServerRequest ? [onServerRequest] : []),
      close: new Set(onClose ? [onClose] : []),
    };
    let closeError;
    let writeTimer;
    let nextId = 1;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    let fragOpcode = null;
    let fragParts = [];
    let fragBytes = 0;
    // Absolute handshake deadline: socket timeouts reset on any bytes, so trickled
    // headers must not extend this. Per-request timers stay absolute after upgrade.
    const handshakeTimer = setTimeout(() => failAll(new Error("Timed out connecting to Codex app-server at " + path)), timeoutMs);
    if (typeof handshakeTimer.unref === "function") handshakeTimer.unref();

    const failAll = (err) => {
      if (closed) return;
      closed = true;
      closeError = err;
      clearTimeout(handshakeTimer);
      clearTimeout(writeTimer);
      signal?.removeEventListener("abort", abort);
      if (err && err.delivery == null) err.delivery = pending.size ? "unknown" : "rejected";
      for (const { reject: rej } of pending.values()) rej(err);
      pending.clear();
      serverRequests.clear();
      client.deferred.length = 0;
      buf = Buffer.alloc(0);
      fragParts = [];
      fragBytes = 0;
      const closeListeners = [...listeners.close];
      for (const group of Object.values(listeners)) group.clear();
      try { socket.destroy(); } catch { /* already gone */ }
      reject(err);
      for (const listener of closeListeners) invoke(listener, err, true);
    };
    // Observers execute synchronously to preserve order, but failures never escape
    // the socket callback. Rejected async callbacks use the same cleanup path.
    const invoke = (listener, message, closing = false) => {
      const failed = (cause) => {
        if (!closing) failAll(new Error("Codex event listener failed", { cause }));
      };
      try {
        const result = listener(message);
        if (result && typeof result.then === "function") Promise.resolve(result).catch(failed);
      } catch (err) { failed(err); }
    };
    const dispatch = (kind, message) => {
      for (const listener of [...listeners[kind]]) {
        if (closed) break;
        if (listeners[kind].has(listener)) invoke(listener, message);
      }
    };
    const subscribe = (kind, listener) => {
      if (typeof listener !== "function") throw new TypeError("Event listener must be a function");
      if (closed) {
        if (kind === "close") invoke(listener, closeError, true);
        return () => {};
      }
      const group = listeners[kind];
      if (!group.has(listener) && group.size >= CODEX_MAX_LISTENERS) {
        const err = new Error("Codex listener limit exceeds " + CODEX_MAX_LISTENERS);
        failAll(err);
        throw err;
      }
      group.add(listener);
      return () => group.delete(listener);
    };
    const abort = () => failAll(new Error("Codex connection aborted", { cause: signal.reason }));
    const failProtocol = (detail) => failAll(new Error("Codex app-server violated the WebSocket protocol: " + detail));
    const write = (opcode, payload) => {
      if (closed) throw closeError;
      const encodedBytes = payload.length + (payload.length < 126 ? 6 : payload.length < 65536 ? 8 : 14);
      if (socket.destroyed || encodedBytes + socket.writableLength > WS_MAX_WRITE_BYTES) {
        const err = new Error(socket.destroyed ? "Codex socket closed" : "Codex outbound write budget exceeds " + WS_MAX_WRITE_BYTES + " bytes");
        failAll(err);
        throw err;
      }
      try {
        if (!socket.write(encodeFrame(opcode, payload, randomBytes(4))) && !writeTimer) {
          // One absolute deadline for the whole backpressured interval: more
          // writes must not keep an unread socket alive indefinitely.
          writeTimer = setTimeout(() => failAll(new Error("Codex outbound write did not drain within " + timeoutMs + "ms")), timeoutMs);
          writeTimer.unref();
        }
      } catch (err) { failAll(err); throw err; }
    };
    const sendJson = (obj) => write(0x1, Buffer.from(JSON.stringify(obj)));
    const respondToRequest = (id, payload) => {
      if (closed) throw closeError;
      if (!serverRequests.has(id)) throw new Error("Unknown or resolved server request: " + id);
      // Consume ownership before JSON.stringify can invoke caller-owned getters
      // or toJSON hooks. A failed serialization closes rather than restoring it.
      serverRequests.delete(id);
      client.deferred = client.deferred.filter(entry => entry.id !== id);
      try { sendJson({ jsonrpc: "2.0", id, ...payload }); }
      catch (cause) {
        if (closed) throw closeError;
        const err = new Error("Codex server response serialization failed", { cause });
        failAll(err);
        throw err;
      }
    };

    const client = {
      refused,
      get closed() { return closed; },
      onNotification: (listener) => subscribe("notification", listener),
      onServerRequest: (listener) => subscribe("serverRequest", listener),
      onClose: (listener) => subscribe("close", listener),
      respond: (id, result) => respondToRequest(id, { result }),
      rejectRequest: (id, error) => respondToRequest(id, { error }),
      // Server-initiated requests are only *answered* once our own turn/start
      // is in flight, and then only when they name our own thread/turn:
      // anything earlier — or naming another thread or Desktop turn — belongs
      // to another client and must never be rejected on their behalf. Early
      // and foreign requests are still recorded; the connection closes right
      // after, so a pending request simply dies with it instead of denying
      // someone's approval.
      answerServerRequests: false,
      expectedThreadId: null,
      expectedTurnId: null,
      // Approvals that name a turn while our own turn id is still unknown
      // (arriving before — or in the same socket batch as — the turn/start
      // acknowledgment) wait here instead of being classified foreign: once
      // the acknowledgment supplies the turn id, matching ones are answered
      // and the rest stay silent.
      deferred: [],
      // Adopt the acknowledged turn id, answering deferred requests that
      // prove to be ours. Runs inside the connection closure so it can send.
      _adoptTurn(turnId) {
        client.expectedTurnId = turnId;
        for (const entry of client.deferred.splice(0)) {
          const params = entry.params && typeof entry.params === "object" && !Array.isArray(entry.params)
            ? entry.params
            : null;
          const threadId = params ? (params.threadId ?? params.thread_id) : null;
          const namedTurnId = params
            ? (params.turnId ?? params.turn_id ?? (params.turn && params.turn.id))
            : null;
          if (threadId === client.expectedThreadId && namedTurnId === turnId && serverRequests.get(entry.id) === entry) {
            client.rejectRequest(entry.id, { code: -32601, message: "gbot codex does not answer " + entry.method + "; configure approval_policy on the daemon" });
            entry.answered = true;
          }
        }
      },
      request(method, params) {
        return new Promise((res, rej) => {
          if (closed) return rej(closeError);
          if (pending.size >= CODEX_MAX_REQUESTS) {
            const err = new Error("Codex pending request limit exceeds " + CODEX_MAX_REQUESTS);
            failAll(err);
            return rej(err);
          }
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error("Codex app-server did not answer " + method + " within " + timeoutMs + "ms"));
          }, timeoutMs);
          pending.set(id, {
            method,
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });
          try { sendJson({ jsonrpc: "2.0", id, method, params }); }
          catch (err) {
            const entry = pending.get(id);
            pending.delete(id);
            entry?.reject(err);
          }
        });
      },
      notify(method, params) {
        sendJson({ jsonrpc: "2.0", method, params });
      },
      close() {
        if (closed) return;
        // Best effort protocol close; cleanup never depends on the peer reading it.
        try { if (upgraded) write(0x8, Buffer.from([0x03, 0xe8])); } catch { /* write already closed the session */ }
        failAll(new Error("Codex client closed"));
      },
    };
    signal?.addEventListener("abort", abort, { once: true });

    const onMessage = (msg) => {
      if (msg.id != null && msg.method) {
        if (serverRequests.has(msg.id)) return failProtocol("duplicate pending server request id");
        if (serverRequests.size >= CODEX_MAX_REQUESTS || refused.length >= CODEX_MAX_REQUESTS || client.deferred.length >= CODEX_MAX_REQUESTS) {
          return failAll(new Error("Codex remembered server request limit exceeds " + CODEX_MAX_REQUESTS));
        }
        const entry = { id: msg.id, method: msg.method, params: msg.params, answered: false };
        serverRequests.set(msg.id, entry);
        dispatch("serverRequest", msg);
        if (closed) return;
        let answered = client.answerServerRequests;
        let defer = false;
        // Approval ownership: only answer requests for the turn gbot itself
        // started. A request naming another thread — or naming a turn that is
        // not ours — is recorded foreign-silent, never rejected. A request
        // naming a turn while our turn id is still unknown is deferred, not
        // classified: the turn/start acknowledgment decides it.
        if (answered) {
          const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params : null;
          if (params) {
            const threadId = params.threadId ?? params.thread_id;
            const turnId = params.turnId ?? params.turn_id ?? (params.turn && params.turn.id);
            if (threadId !== client.expectedThreadId || turnId == null) answered = false;
            else if (client.expectedTurnId == null) { answered = false; defer = true; }
            else if (turnId !== client.expectedTurnId) answered = false;
          } else answered = false;
        }
        answered = answered && serverRequests.has(msg.id);
        defer = defer && serverRequests.has(msg.id);
        entry.answered = answered;
        refused.push(entry);
        if (defer) {
          client.deferred.push(entry);
          return;
        }
        if (!answered) return;
        client.rejectRequest(msg.id, { code: -32601, message: "gbot codex does not answer " + msg.method + "; configure approval_policy on the daemon" });
        return;
      }
      if (msg.id == null && msg.method) {
        if (msg.method === "serverRequest/resolved") {
          const id = msg.params?.requestId;
          serverRequests.delete(id);
          client.deferred = client.deferred.filter(entry => entry.id !== id);
        }
        dispatch("notification", msg);
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
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        failAll(new Error("Codex app-server sent a malformed message"));
        return;
      }
      try { onMessage(msg); } catch (err) { failAll(err); }
    };

    socket.on("drain", () => {
      clearTimeout(writeTimer);
      writeTimer = undefined;
    });
    socket.once("error", (err) => failAll(new Error("Could not connect to Codex app-server at " + path + ": " + err.message)));
    socket.once("close", () => failAll(new Error("Codex app-server closed the connection")));
    socket.once("connect", () => socket.write(upgradeRequest(key)));
    socket.on("data", (chunk) => {
      if (closed) return;
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) {
          if (buf.length > WS_MAX_HEADER_BYTES) failAll(new Error("Codex app-server handshake headers exceed " + WS_MAX_HEADER_BYTES + " bytes"));
          return;
        }
        // Terminated headers hit the cap too; size is checked before any decoding.
        if (end > WS_MAX_HEADER_BYTES) return failAll(new Error("Codex app-server handshake headers exceed " + WS_MAX_HEADER_BYTES + " bytes"));
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        if (!validateUpgradeHead(head, key)) return failAll(new Error("Codex app-server refused the WebSocket upgrade: " + head.split("\r\n")[0]));
        upgraded = true;
        clearTimeout(handshakeTimer);
        resolve(client);
      }
      while (!closed) {
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
        if (frame.payload.length > WS_MAX_MESSAGE_BYTES) return failAll(new Error("Codex app-server frame exceeds " + WS_MAX_MESSAGE_BYTES + " bytes"));
        if (frame.masked) return failProtocol("server frames must not be masked");
        if (frame.opcode >= 0x8) {
          if (!frame.fin || frame.payload.length > 125) return failProtocol("bad control frame");
          if (frame.opcode === 0x9) {
            try { write(0xa, frame.payload); } catch { return; }
          }
          else if (frame.opcode === 0x8) {
            try { write(0x8, frame.payload); } catch { return; }
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

/** Throws CodexRouteError when the operator's socket cannot be used; the path comes only from CODEX_HOME. */
export function assertRoute(path) {
  if (process.platform === "win32") throw new CodexRouteError(windowsUnsupportedMessage(), "windows-unsupported");
  const state = socketState(path);
  if (state === "socket") return;
  if (state === "permission-denied") {
    throw new CodexRouteError("Codex app-server control socket at " + path + " exists but this user may not access it. "
      + "gbot runs as the user who owns CODEX_HOME; check the socket's owner and mode.", "permission-denied");
  }
  if (state === "not-a-socket") {
    throw new CodexRouteError(path + " exists but is not a Unix socket; remove the stale file and restart the daemon.", "not-a-socket");
  }
  throw new CodexRouteError(unreachableMessage(path), "socket-absent");
}

export async function openCodexSession(env = process.env, { experimental = false, ...options } = {}) {
  const path = codexSocketPath(env);
  assertRoute(path);
  let client;
  try {
    client = await connectCodexAppServer(path, options);
  } catch (err) {
    throw connectError(err, path);
  }
  let init;
  try {
    init = await client.request("initialize", {
      clientInfo: { name: "gbot", version: pkg.version },
      ...(experimental ? { capabilities: { experimentalApi: true } } : {}),
    });
  } catch (err) {
    client.close();
    throw handshakeError(err);
  }
  if (!isObject(init)) {
    client.close();
    throw new CodexProtocolError("initialize", "result is not an object");
  }
  try { client.notify("initialized"); }
  catch (err) { client.close(); throw handshakeError(err); }
  return { client, path, init };
}

const openSession = openCodexSession;

export const CODEX_VERSION_PROBE_TIMEOUT_MS = 3000;

/** Bounded `codex --version` probe: `{ version, probe }` where probe is ok | missing | timeout | error. */
export function probeLocalCodexVersion(timeoutMs = CODEX_VERSION_PROBE_TIMEOUT_MS) {
  const out = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: timeoutMs });
  if (out.error) {
    if (out.error.code === "ENOENT") return { version: null, probe: "missing" };
    if (out.error.code === "ETIMEDOUT") return { version: null, probe: "timeout" };
    return { version: null, probe: "error" };
  }
  const m = out.status === 0 ? /(\d+\.\d+\.\d+\S*)/.exec(out.stdout) : null;
  return m ? { version: m[1], probe: "ok" } : { version: null, probe: "error" };
}

/** Bounded `ps` snapshot for Desktop detection: process names only, never pipes or sockets. */
export const DESKTOP_PROCESS_LIST_TIMEOUT_MS = 3000;

export function listDesktopProcesses(timeoutMs = DESKTOP_PROCESS_LIST_TIMEOUT_MS) {
  if (process.platform === "win32") return "";
  try {
    const out = spawnSync("ps", ["-eo", "args"], { encoding: "utf8", timeout: timeoutMs });
    if (out.error || out.status !== 0 || typeof out.stdout !== "string") return "";
    return out.stdout;
  } catch {
    return "";
  }
}

/**
 * Pure Desktop private-stdio detector. Returns `"private-stdio"` when the process list
 * shows Desktop's bundled `.../ChatGPT.app/.../Resources/codex` running `app-server`
 * (the `codex_app` override corroborates, the Resources path alone suffices); `"unknown"`
 * otherwise. Never `"detached"`: absence of a match means "not observed", not "not running".
 * Windows stays `"unknown"` (unsupported route, unchanged).
 *
 * @param {{ platform?: string, listProcesses?: string | string[] | null }} [opts]
 */
export function detectDesktopPrivateAppServer({ platform = process.platform, listProcesses = "" } = {}) {
  if (platform === "win32") return "unknown";
  const lines = Array.isArray(listProcesses) ? listProcesses : String(listProcesses ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!/app-server/.test(line)) continue;
    // Desktop's bundled binary, Mac or Windows-style separators with optional .exe.
    if (/ChatGPT\.app[\\/].*Resources[\\/]codex(\.exe)?(["'\s]|$)/.test(line)) return "private-stdio";
    // Same app-server line owned by ChatGPT.app carrying the app-tools override.
    if (/ChatGPT\.app/.test(line) && /(codex_app|mcp_servers\.codex_app|codex-app-tools)/.test(line)) return "private-stdio";
  }
  return "unknown";
}

/**
 * Status contract: `reachable` is endpoint reachability only. `schema.compatibility` is
 * `exact` when the daemon reports the pinned version, otherwise `unverified` (methods
 * usually survive upgrades) or `unknown`. `desktopShimConfigured` records an installed
 * wrapper selected by Desktop-facing CODEX_CLI_PATH (the GUI domain on Darwin).
 * Configuration does not prove a running Desktop inherited it or connected.
 * `desktopAttached` is `"private-stdio"` when a Desktop-bundled app-server process
 * is visible, otherwise `"unknown"`. Managed attachment is not observable here.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ listProcesses?: string | string[], shim?: { installed?: boolean, wrapperPointsAtShim?: boolean } | null }} [opts]
 *   injected process list and shim state for tests; defaults to a live `ps` snapshot and
 *   `desktopShimStatus`. Never reads pipes or connects to Desktop.
 */
export async function codexStatus(env = process.env, { listProcesses, shim } = {}) {
  const path = codexSocketPath(env);
  const cli = probeLocalCodexVersion();
  let desktopShimConfigured = Boolean(shim && shim.installed && shim.wrapperPointsAtShim);
  if (shim === undefined) {
    try {
      const live = desktopShimStatus({ env });
      desktopShimConfigured = Boolean(live.installed && live.wrapperPointsAtShim);
    } catch {
      desktopShimConfigured = false;
    }
  }
  const desktopAttached = detectDesktopPrivateAppServer({
    platform: process.platform,
    listProcesses: listProcesses ?? listDesktopProcesses(),
  });
  const base = {
    socketPath: path,
    socketState: socketState(path),
    pinnedVersion: PINNED_CODEX_VERSION,
    cliVersion: cli.version,
    cliVersionProbe: cli.probe,
    desktopAttached,
    desktopShimConfigured,
  };
  let session;
  try {
    session = await openSession(env);
  } catch (err) {
    if (err instanceof CodexRouteError) {
      // Name the private-stdio case explicitly: Desktop is up but unreachable, so the
      // operator needs a managed standalone daemon, not a Desktop reconnect.
      const message = err.mode === "socket-absent" ? unreachableMessage(path, desktopAttached) : err.message;
      return withStatusExitCode({ ...base, reachable: false, mode: err.mode, message });
    }
    // The endpoint answered; what it said does not match the pinned schema.
    if (err instanceof CodexProtocolError) return withStatusExitCode({ ...base, reachable: true, mode: err.mode, message: err.message });
    throw err;
  }
  session.client.close();
  const daemonVersion = appServerVersion(session.init);
  return withStatusExitCode({
    ...base,
    reachable: true,
    mode: "daemon",
    daemonVersion,
    codexHome: typeof session.init.codexHome === "string" ? session.init.codexHome : null,
    schema: {
      pinned: PINNED_CODEX_VERSION,
      daemon: daemonVersion,
      compatibility: daemonVersion == null ? "unknown" : daemonVersion === PINNED_CODEX_VERSION ? "exact" : "unverified",
    },
    versionMismatch: Boolean(base.cliVersion && daemonVersion && base.cliVersion !== daemonVersion),
  });
}

const THREAD_STATUSES = new Set(["notLoaded", "idle", "active", "systemError"]);

function lineField(value) {
  return value == null ? null : singleLine(value);
}

/** Server text fields are sanitized; structured values (Codex's `source: { custom }`) pass through untouched. */
function sourceField(value) {
  if (value == null) return null;
  return typeof value === "string" ? singleLine(value) : value;
}

export function summarizeThread(t) {
  if (!isObject(t) || typeof t.id !== "string" || !t.id) throw new CodexProtocolError("thread/list", "entry without a string `id`");
  const type = isObject(t.status) && typeof t.status.type === "string" ? t.status.type : "unknown";
  return {
    id: singleLine(t.id),
    status: THREAD_STATUSES.has(type) ? type : "unknown",
    activeFlags: isObject(t.status) && Array.isArray(t.status.activeFlags) ? t.status.activeFlags.map((f) => singleLine(f)) : [],
    name: lineField(t.name),
    preview: typeof t.preview === "string" ? stripTerminalControls(t.preview) : "",
    cwd: lineField(t.cwd),
    source: sourceField(t.source),
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : null,
  };
}

export const THREAD_LIST_MAX_LIMIT = 200;

/**
 * @param {{ limit?: number, cursor?: string, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function listCodexThreads({ limit = 20, cursor, env = process.env } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > THREAD_LIST_MAX_LIMIT) {
    throw new RangeError("--limit must be an integer 1-" + THREAD_LIST_MAX_LIMIT);
  }
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) throw new RangeError("--cursor must be a non-empty string");
  const { client } = await openSession(env);
  try {
    // The default listing rescans every rollout file to repair metadata (26 s on a busy machine);
    // the state DB already holds what we print.
    const params = { limit, useStateDbOnly: true, ...(cursor !== undefined ? { cursor } : {}) };
    let out;
    try {
      out = await client.request("thread/list", params);
    } catch (err) {
      throw transportError(err);
    }
    if (!isObject(out) || !Array.isArray(out.data)) throw new CodexProtocolError("thread/list", "missing `data` array");
    if (out.nextCursor != null && typeof out.nextCursor !== "string") throw new CodexProtocolError("thread/list", "`nextCursor` is not a string");
    const threads = out.data.map(summarizeThread);
    return { threads, nextCursor: out.nextCursor ?? null, limit };
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

export const DEFAULT_MAX_HOPS = 4;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Delivery envelope: `messageId` names this send, `correlationId` names the conversation it
 * belongs to, `replyTo` names the message it answers, `hop` counts agent-to-agent forwards.
 * `maxHops` (GROK_BOT_MAX_HOPS) bounds relays: a reply must carry hop = incoming hop + 1, and a
 * send at or past the bound is refused, so two agents cannot ack each other forever.
 * The textual header is caller-authored provenance for the reader, not authentication.
 * @param {{ correlationId?: string, replyTo?: string, hop?: number, envelope?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 */
export function buildEnvelope({ correlationId, replyTo, hop, envelope = false, env = process.env } = {}) {
  const maxHops = Number.parseInt(env.GROK_BOT_MAX_HOPS ?? "", 10);
  const bound = Number.isInteger(maxHops) && maxHops >= 0 ? maxHops : DEFAULT_MAX_HOPS;
  for (const [name, value] of [["--correlation-id", correlationId], ["--reply-to", replyTo]]) {
    if (value !== undefined && !ID_PATTERN.test(value)) throw new RangeError(name + " must be 1-128 characters of [A-Za-z0-9_.:-]");
  }
  const hopCount = hop === undefined ? 0 : hop;
  if (!Number.isInteger(hopCount) || hopCount < 0) throw new RangeError("--hop must be a non-negative integer");
  if (replyTo !== undefined && correlationId === undefined) {
    throw new RangeError("--reply-to needs the original --correlation-id so the reply stays in its conversation");
  }
  const messageId = randomUUID();
  const out = {
    messageId,
    correlationId: correlationId ?? messageId,
    hop: hopCount,
    maxHops: bound,
    header: envelope || replyTo !== undefined || hop !== undefined || correlationId !== undefined,
  };
  if (replyTo !== undefined) out.replyTo = replyTo;
  if (hopCount >= bound) {
    throw new CodexSendError(
      "Refusing to send: hop " + hopCount + " reaches the relay bound " + bound + " (GROK_BOT_MAX_HOPS). "
      + "This message is an agent-to-agent relay that has already been forwarded too many times.",
      { delivery: "rejected", reason: "hop-limit", envelope: out },
    );
  }
  return out;
}

/** One-line header a receiving agent can read to reply with `--reply-to` and `--hop N+1`. */
const identityToken = (value) => String(value ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "unknown";

export function envelopeHeader(envelope, env = process.env) {
  const from = identityToken(env.USER || env.USERNAME) + "@" + hostnameSafe();
  const parts = ["msg=" + envelope.messageId, "corr=" + envelope.correlationId];
  if (envelope.replyTo) parts.push("reply-to=" + envelope.replyTo);
  parts.push("hop=" + envelope.hop, "from=" + from);
  return "[gbot " + parts.join(" ") + "]";
}

function hostnameSafe() {
  try {
    return identityToken(hostname());
  } catch {
    return "unknown";
  }
}

export function withEnvelopeHeader(text, envelope, env = process.env) {
  return envelope.header ? envelopeHeader(envelope, env) + "\n" + text : text;
}

/** Operator-controlled destinations: GROK_BOT_CODEX_THREADS="id,id" restricts `codex send`. */
export function assertThreadAllowed(threadId, env = process.env) {
  const raw = env.GROK_BOT_CODEX_THREADS;
  if (raw == null || raw.trim() === "") return;
  const allowed = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(threadId)) {
    throw new CodexSendError(
      "Codex thread " + threadId + " is not in GROK_BOT_CODEX_THREADS; the operator allows only: " + allowed.join(", "),
      { delivery: "rejected", reason: "route-not-allowed", threadId },
    );
  }
}

/**
 * Busy destinations. In app-server 0.154.0 `turn/start` on a thread with an active turn steers
 * that turn instead of queueing (TurnStartParams.turnTrigger: "Ignored when this request steers
 * an already-active turn"). gbot never steers or interrupts human work: an `active` thread is
 * refused with a `busy` receipt, or, with `whenBusy: "queue"`, handed to the daemon's own queue
 * through the experimental `thread/queue/add`. See docs/codex-busy-threads.md.
 */
function threadState(resumed, threadId) {
  const status = resumed.thread.status;
  const type = isObject(status) && typeof status.type === "string" ? status.type : "unknown";
  if (type === "idle" || type === "notLoaded") return { type, busy: false };
  if (type === "active") {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags.map((f) => singleLine(f)) : [];
    return { type, busy: true, flags };
  }
  if (type === "systemError") {
    throw new CodexSendError("Codex thread " + threadId + " is in systemError state; open it in a Codex client first.",
      { delivery: "rejected", reason: "thread-error", threadId });
  }
  throw new CodexSendError("Codex thread " + threadId + " reports status " + JSON.stringify(type) + ", which this gbot (pinned to app-server "
    + PINNED_CODEX_VERSION + ") does not know; not sending.", { delivery: "rejected", reason: "unknown-status", threadId });
}

export function experimentalEnabled(env = process.env) {
  return /^(1|true|on)$/i.test(env.GROK_BOT_CODEX_EXPERIMENTAL || "");
}

function requireExperimental(env, what) {
  if (experimentalEnabled(env)) return;
  throw new CodexSendError(what + " uses Codex's experimental app-server API (thread/queue/*), which is off by default. "
    + "Set GROK_BOT_CODEX_EXPERIMENTAL=1 to opt in; method names are pinned to Codex " + PINNED_CODEX_VERSION + ".",
    { delivery: "rejected", reason: "experimental-disabled" });
}

function unsupportedOrRpc(err, method, threadId, envelope, turnId) {
  const guarded = method === "turn/steer";
  if (err instanceof CodexRpcError && err.rpc && err.rpc.code === -32601) {
    return new CodexSendError("Codex app-server does not offer " + method + " (daemon predates it, or experimentalApi was not granted). "
      + (guarded ? "Upgrade Codex before retrying guarded steering." : "Upgrade Codex or send without --when-busy queue."),
      { delivery: "rejected", reason: "unsupported", threadId, turnId, envelope });
  }
  if (err instanceof CodexRpcError) return new CodexSendError(err.message, { delivery: "rejected", reason: "rejected", threadId, turnId, envelope });
  return new CodexSendError("Lost the Codex " + method + " response for thread " + threadId + ": " + ((err && err.message) || err)
    + (guarded ? ". Delivery is unknown; check thread " + threadId + " turn " + turnId + " before resending."
      : ". Delivery is unknown; list the queue before resending."),
    { delivery: (err && err.delivery) || "unknown", reason: "transport", threadId, turnId, envelope });
}

/** Read the daemon's queue for one thread (experimental `thread/queue/list`). */
export async function listCodexQueue(threadId, { env = process.env, limit = 50, cursor } = {}) {
  requireExperimental(env, "gbot codex queue");
  const { client } = await openSession(env, { experimental: true });
  try {
    let out;
    try {
      out = await client.request("thread/queue/list", { threadId, limit, ...(cursor !== undefined ? { cursor } : {}) });
    } catch (err) {
      throw unsupportedOrRpc(err, "thread/queue/list", threadId);
    }
    if (!isObject(out) || !Array.isArray(out.data)) throw new CodexProtocolError("thread/queue/list", "missing `data` array");
    return {
      threadId,
      queued: out.data.map((q) => ({
        id: isObject(q) && typeof q.id === "string" ? singleLine(q.id) : null,
        clientUserMessageId: isObject(q) && typeof q.clientUserMessageId === "string" ? singleLine(q.clientUserMessageId) : null,
        text: isObject(q) && Array.isArray(q.input) ? q.input.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n") : "",
      })),
      nextCursor: typeof out.nextCursor === "string" ? out.nextCursor : null,
    };
  } finally {
    client.close();
  }
}

/**
 * @param {string} threadId
 * @param {string} text
 * @param {{ env?: NodeJS.ProcessEnv, envelope?: object, whenBusy?: "reject"|"queue"|"steer", session?: object, expectedTurnId?: string, expectedCwd?: string, signal?: AbortSignal }} [opts]
 */
export async function sendToCodexThread(threadId, text, { env = process.env, envelope = buildEnvelope({ env }), whenBusy = "reject", session, expectedTurnId, expectedCwd, signal } = {}) {
  try {
    const receipt = await sendToCodexThreadInner(threadId, text, { env, envelope, whenBusy, session, expectedTurnId, expectedCwd, signal });
    return outcomeFromReceipt(receipt);
  } catch (err) {
    // Every receipt names the message, including refusals that never reached the daemon.
    if (err && typeof err === "object") {
      err.envelope = envelope;
      if (err.threadId === undefined) err.threadId = threadId;
    }
    return outcomeFromError(err);
  }
}

async function sendToCodexThreadInner(threadId, text, { env, envelope, whenBusy, session, expectedTurnId, expectedCwd, signal }) {
  if (!["reject", "queue", ...(session ? ["steer"] : [])].includes(whenBusy)) throw new RangeError("--when-busy must be reject, queue, or persistent steer");
  if (whenBusy === "steer" && (typeof expectedTurnId !== "string" || !ID_PATTERN.test(expectedTurnId))) throw new RangeError("steer requires expectedTurnId");
  if (typeof threadId !== "string" || !ID_PATTERN.test(threadId)) throw new RangeError("Invalid threadId");
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > WS_MAX_MESSAGE_BYTES) throw new RangeError("Message must contain text within 4 MiB");
  if (!envelope || typeof envelope.messageId !== "string" || !ID_PATTERN.test(envelope.messageId)) throw new RangeError("Invalid envelope messageId");
  const validated = buildEnvelope({ correlationId: envelope.correlationId, replyTo: envelope.replyTo, hop: envelope.hop, env });
  envelope = { ...validated, messageId: envelope.messageId, header: Boolean(envelope.header) };
  assertThreadAllowed(threadId, env);
  if (whenBusy === "queue") requireExperimental(env, "--when-busy queue");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  const assertNotCancelled = () => {
    if (signal?.aborted) throw new CodexSendError("Codex submission cancelled before delivery", {
      delivery: "rejected", reason: "cancelled", threadId, turnId: whenBusy === "steer" ? expectedTurnId : undefined, envelope,
    });
  };
  assertNotCancelled();
  const body = withEnvelopeHeader(text, envelope, env);
  const { client } = session ?? await openSession(env, { experimental: whenBusy === "queue", signal });
  try {
    let resumed;
    try {
      resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
    } catch (err) {
      assertNotCancelled();
      if (err instanceof CodexSendError) throw err;
      throw new CodexSendError(explainSendError(err, threadId).message, {
        delivery: err instanceof CodexRpcError ? "rejected" : (err && err.delivery) || "unknown",
        reason: err instanceof CodexRpcError ? (/no rollout found|thread not found/i.test(String(err.rpc && err.rpc.message)) ? "unknown-thread"
          : /active writer/i.test(String(err.rpc && err.rpc.message)) ? "external-owner" : "rejected") : "transport",
        threadId,
        envelope,
      });
    }
    // A shared session stays connected when this conversation is cancelled.
    // Recheck after the last awaited preflight, before any submission request.
    assertNotCancelled();
    if (!isObject(resumed) || !isObject(resumed.thread) || typeof resumed.thread.id !== "string") {
      throw new CodexProtocolError("thread/resume", "missing `thread.id`");
    }
    if (resumed.thread.id !== threadId) throw new CodexSendError("thread/resume returned a different thread ID", { delivery: "rejected", reason: "bad-response", threadId, envelope });
    if (expectedCwd !== undefined && realpathSync(resumed.cwd ?? resumed.thread.cwd) !== realpathSync(expectedCwd)) throw new CodexSendError("Codex thread cwd does not match expectedCwd", { delivery: "rejected", reason: "cwd-mismatch", threadId, envelope });
    const state = threadState(resumed, threadId);
    const receiptBase = {
      threadId: resumed.thread.id,
      threadStatus: state.type,
      model: resumed.model,
      cwd: resumed.cwd,
      approvalPolicy: resumed.approvalPolicy,
      messageId: envelope.messageId,
      correlationId: envelope.correlationId,
      ...(envelope.replyTo ? { replyTo: envelope.replyTo } : {}),
      hop: envelope.hop,
      maxHops: envelope.maxHops,
    };
    if (state.busy && whenBusy === "reject") {
      const flags = state.flags.length ? " (" + state.flags.join(", ") + ")" : "";
      throw new CodexSendError(
        "Codex thread " + threadId + " has an active turn" + flags + "; sending now would steer that turn. "
        + "Wait for it to go idle (`gbot codex list-threads`) and resend, or pass --when-busy queue.",
        { delivery: "rejected", reason: "busy", threadId, envelope },
      );
    }
    if (whenBusy === "steer") {
      let steered;
      try {
        steered = await client.request("turn/steer", { threadId, expectedTurnId, clientUserMessageId: envelope.messageId, input: [{ type: "text", text: body }] });
      } catch (err) { throw unsupportedOrRpc(err, "turn/steer", threadId, envelope, expectedTurnId); }
      if (typeof steered?.turnId !== "string" || steered.turnId !== expectedTurnId) {
        throw new CodexSendError("Malformed turn/steer acknowledgment", { delivery: "unknown", reason: "bad-response", threadId, turnId: expectedTurnId, envelope });
      }
      return { delivery: "accepted", ...receiptBase, turnId: steered.turnId };
    }
    if (state.busy) {
      let queued;
      try {
        queued = await client.request("thread/queue/add", { threadId, clientUserMessageId: envelope.messageId, input: [{ type: "text", text: body }] });
      } catch (err) {
        throw unsupportedOrRpc(err, "thread/queue/add", threadId, envelope);
      }
      const submission = isObject(queued) && isObject(queued.queuedSubmission) && typeof queued.queuedSubmission.id === "string" ? queued.queuedSubmission : null;
      if (!submission) {
        throw new CodexSendError("Codex app-server sent a malformed thread/queue/add acknowledgment for thread " + threadId
          + ". Delivery is unknown; list the queue before resending.", { delivery: "unknown", reason: "bad-response", threadId, envelope });
      }
      return { delivery: "queued", ...receiptBase, queuedSubmissionId: submission.id, activeFlags: state.flags };
    }
    // ponytail: idle-at-resume then turn/start is a small race with a human starting a turn first;
    // the daemon exposes no compare-and-start request. Upgrade path: thread/queue/add + thread/queue/start once stable.
    // Scope refusals to this turn: server requests from earlier calls belong to another context.
    const seenRefused = client.refused.length;
    // Arm refusal replies only now that our own turn/start is in flight, scoped
    // to our own thread/turn: anything recorded earlier (resume, busy reject,
    // queue) — or naming another thread or Desktop turn — stays unanswered so
    // gbot never rejects another client's approval. Requests naming a turn
    // that arrives before the acknowledgment supplies our turn id wait in
    // client.deferred and are adopted only on a match. Requests missing
    // thread or turn IDs remain unanswered because ownership is unknown.
    if (!session) {
      client.expectedThreadId = threadId;
      client.expectedTurnId = null;
      client.answerServerRequests = true;
    }
    let turn;
    try {
      turn = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: body }],
        clientUserMessageId: envelope.messageId,
        turnTrigger: "gbot",
      });
    } catch (err) {
      if (err instanceof CodexSendError) throw err;
      const delivery = err instanceof CodexRpcError ? "rejected" : (err && err.delivery) || "unknown";
      const detail = err instanceof CodexRpcError
        ? err.message
        : "Lost the Codex turn/start response for thread " + threadId + ": " + ((err && err.message) || err)
          + ". Delivery is unknown; check the thread before resending.";
      // No blind retry: the receipt carries messageId so the caller can look for it before resending.
      throw new CodexSendError(detail, { delivery, reason: delivery === "rejected" ? "rejected" : "transport", threadId, envelope });
    }
    const turnId = turn && turn.turn && typeof turn.turn.id === "string" && turn.turn.id ? turn.turn.id : null;
    if (!turnId) {
      throw new CodexSendError(
        "Codex app-server sent a malformed turn/start acknowledgment for thread " + threadId + ". Delivery is unknown; check the thread before resending.",
        { delivery: "unknown", reason: "bad-response", threadId, envelope },
      );
    }
    if (!session) client._adoptTurn(turnId);
    const freshRefused = client.refused.slice(seenRefused)
      .filter((r) => {
        if (!r.answered) return false;
        const params = r.params && typeof r.params === "object" && !Array.isArray(r.params) ? r.params : null;
        if (!params) return true;
        const refusedThreadId = params.threadId ?? params.thread_id;
        const refusedTurnId = params.turnId ?? params.turn_id ?? (params.turn && params.turn.id);
        if (refusedThreadId != null && refusedThreadId !== threadId) return false;
        if (refusedTurnId != null && refusedTurnId !== turnId) return false;
        return true;
      });
    if (freshRefused.length) {
      const methods = freshRefused.map((r) => r.method).join(", ");
      throw new CodexSendError(
        "Turn " + turnId + " started on thread " + threadId + " but Codex asked for " + methods + ", which gbot refused. "
        + "Answer it in a Codex client, or set `approval_policy = \"never\"` in the daemon's config.toml for unattended sends.",
        { delivery: "accepted", reason: "approval-refused", threadId, turnId, refused: freshRefused.map((r) => r.method), envelope },
      );
    }
    return { delivery: "accepted", ...receiptBase, turnId, turnStatus: turn.turn.status };
  } finally {
    if (!session) client.close();
  }
}
