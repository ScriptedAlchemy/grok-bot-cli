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
  return { fin, opcode, payload, rest: buf.subarray(offset + len) };
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

    const failAll = (err) => {
      if (closed) return;
      closed = true;
      for (const { reject: rej } of pending.values()) rej(err);
      pending.clear();
      reject(err);
    };
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
        closed = true;
        write(0x8, Buffer.from([0x03, 0xe8]));
        socket.end();
        socket.unref();
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

    socket.setTimeout(timeoutMs, () => failAll(new Error("Timed out connecting to Codex app-server at " + path)));
    socket.once("error", (err) => failAll(new Error("Could not connect to Codex app-server at " + path + ": " + err.message)));
    socket.once("close", () => failAll(new Error("Codex app-server closed the connection")));
    socket.once("connect", () => socket.write(upgradeRequest(key)));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        const ok = /^HTTP\/1\.1 101/.test(head)
          && head.toLowerCase().includes("sec-websocket-accept: " + websocketAccept(key).toLowerCase());
        if (!ok) return failAll(new Error("Codex app-server refused the WebSocket upgrade: " + head.split("\r\n")[0]));
        upgraded = true;
        socket.setTimeout(0);
        resolve(client);
      }
      // ponytail: unfragmented frames only; the app-server sends each JSON-RPC message as one text frame.
      for (;;) {
        const frame = decodeFrame(buf);
        if (!frame) return;
        buf = frame.rest;
        if (frame.opcode === 0x1) {
          try {
            onMessage(JSON.parse(frame.payload.toString()));
          } catch (err) {
            failAll(new Error("Codex app-server sent an unreadable message: " + err.message));
          }
        } else if (frame.opcode === 0x9) write(0xa, frame.payload);
        else if (frame.opcode === 0x8) socket.end();
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
  const path = codexSocketPath(env);
  if (!socketPresent(path)) throw new Error(unreachableMessage(path));
  const client = await connectCodexAppServer(path);
  const init = await client.request("initialize", { clientInfo: { name: "gbot", version: pkg.version } });
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
      throw explainSendError(err, threadId);
    }
    const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text }] });
    if (client.refused.length) {
      const methods = client.refused.map((r) => r.method).join(", ");
      throw new Error(
        "Turn " + turn.turn.id + " started on thread " + threadId + " but Codex asked for " + methods + ", which gbot refused. "
        + "Answer it in a Codex client, or set `approval_policy = \"never\"` in the daemon's config.toml for unattended sends.",
      );
    }
    return {
      threadId: resumed.thread.id,
      turnId: turn.turn.id,
      turnStatus: turn.turn.status,
      model: resumed.model,
      cwd: resumed.cwd,
      approvalPolicy: resumed.approvalPolicy,
    };
  } finally {
    client.close();
  }
}
