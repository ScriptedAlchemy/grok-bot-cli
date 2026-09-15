import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeFrame, encodeFrame, websocketAccept, connectCodexAppServer, sendToCodexThread } from "../src/core/codex-bridge.js";
import { createServer as createTcpServer } from "node:net";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));

const THREADS = [
  { id: "t-1", status: { type: "idle" }, name: "Fix the build", preview: "please fix the build", cwd: "/repo/a", source: "vscode", updatedAt: 1700000001 },
  { id: "t-2", status: { type: "notLoaded" }, name: null, preview: "second   thread\npreview", cwd: "/repo/b", source: "cli", updatedAt: 1700000000 },
];

/**
 * Fake Codex app-server: WebSocket over a Unix socket under a scratch CODEX_HOME.
 * `handlers[method](params, reply)` answers each request; `received` keeps every inbound message.
 */
async function fakeAppServer(handlers) {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const received = [];
  const sockets = new Set();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
    close: () => new Promise((resolve) => {
      for (const sock of sockets) sock.destroy();
      server.close(resolve);
    }),
  };
}

const baseHandlers = {
  initialize: (params, ok) => ok({ userAgent: "gbot/0.154.0 (Ubuntu 24.4.0; x86_64) dumb (" + params.clientInfo.name + ")", codexHome: "/fake" }),
  "thread/list": (params, ok) => ok({ data: THREADS.slice(0, params.limit), nextCursor: params.limit < THREADS.length ? "cursor-2" : null }),
  "thread/resume": (params, ok, err) => {
    const t = THREADS.find((x) => x.id === params.threadId);
    if (!t) return err({ code: -32600, message: "no rollout found for thread id " + params.threadId });
    if (t.id === "t-2") return err({ code: -32600, message: "thread " + t.id + " already has an active writer" });
    ok({ thread: t, model: "gpt-6", cwd: t.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", modelProvider: "openai" });
  },
  "turn/start": (params, ok) => ok({ turn: { id: "turn-9", status: "inProgress", items: [] } }),
};

// The fake server runs in this process, so the CLI must be spawned asynchronously.
function gbot(home, ...args) {
  const env = { ...process.env, CODEX_HOME: home, PATH: "/nonexistent" };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env }, (error, out, err) => {
      resolve({ code: error ? error.code : 0, out, err });
    });
  });
}

test("encodeFrame masks a client text frame per RFC 6455", () => {
  const frame = encodeFrame(0x1, Buffer.from("Hello"), Buffer.from([0x37, 0xfa, 0x21, 0x3d]));
  assert.equal(frame.toString("hex"), "818537fa213d7f9f4d5158");
  const back = decodeFrame(frame);
  assert.equal(back.payload.toString(), "Hello");
  assert.equal(back.rest.length, 0);
});

test("websocketAccept and frame headers match the RFC 6455 vectors", () => {
  assert.equal(websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(encodeFrame(0x1, Buffer.alloc(125)).subarray(0, 2).toString("hex"), "817d");
  assert.equal(encodeFrame(0x1, Buffer.alloc(126)).subarray(0, 4).toString("hex"), "817e007e");
  assert.equal(encodeFrame(0x1, Buffer.alloc(65536)).subarray(0, 10).toString("hex"), "817f0000000000010000");
  assert.equal(decodeFrame(encodeFrame(0x1, Buffer.alloc(65536))).payload.length, 65536);
});

test("decodeFrame waits for a complete frame and returns the remainder", () => {
  const two = Buffer.concat([encodeFrame(0x1, Buffer.from("a")), encodeFrame(0x1, Buffer.from("bc"))]);
  assert.equal(decodeFrame(two.subarray(0, 2)), null);
  const first = decodeFrame(two);
  assert.equal(first.payload.toString(), "a");
  assert.equal(decodeFrame(first.rest).payload.toString(), "bc");
});

test("codex status explains an absent socket and exits 1", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-empty-"));
  const { code, out } = await gbot(home, "codex", "status", "--json");
  assert.equal(code, 1);
  const status = JSON.parse(out);
  assert.equal(status.reachable, false);
  assert.equal(status.mode, "socket-absent");
  assert.equal(status.socketPath, join(home, "app-server-control", "app-server-control.sock"));
  assert.match(status.message, /codex app-server daemon start/);
  assert.match(status.message, /ChatGPT Desktop/);
  assert.match(status.message, /openai\/codex\/issues\/41014/);
});

test("codex status reports the daemon version over the socket", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, out } = await gbot(fake.home, "codex", "status", "--json");
    assert.equal(code, 0, out);
    const status = JSON.parse(out);
    assert.equal(status.reachable, true);
    assert.equal(status.mode, "daemon");
    assert.equal(status.daemonVersion, "0.154.0");
    assert.equal(status.codexHome, "/fake");
    assert.equal(status.cliVersion, null);
    assert.equal(status.versionMismatch, false);
    assert.deepEqual(fake.received.map((m) => m.method), ["initialize", "initialized"]);
  } finally {
    await fake.close();
  }
});

test("codex list-threads passes --limit and prints threads", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const text = await gbot(fake.home, "codex", "list-threads", "--limit", "1");
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "t-1  idle - Fix the build\n    /repo/a\n    please fix the build\n\nmore: --cursor \"cursor-2\"\n");
    assert.deepEqual(fake.received.find((m) => m.method === "thread/list").params, { limit: 1, useStateDbOnly: true });

    const json = await gbot(fake.home, "codex", "list-threads", "--json");
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), {
      threads: [
        { id: "t-1", status: "idle", activeFlags: [], name: "Fix the build", preview: "please fix the build", cwd: "/repo/a", source: "vscode", updatedAt: 1700000001 },
        { id: "t-2", status: "notLoaded", activeFlags: [], name: null, preview: "second   thread\npreview", cwd: "/repo/b", source: "cli", updatedAt: 1700000000 },
      ],
      nextCursor: null,
      limit: 20,
      exitCode: 0,
    });
    assert.deepEqual(fake.received.at(-1).params, { limit: 20, useStateDbOnly: true });
  } finally {
    await fake.close();
  }
});

test("codex list-threads rejects a bad --limit", async () => {
  const { code, err } = await gbot("/nonexistent", "codex", "list-threads", "--limit", "0");
  assert.equal(code, 2);
  assert.match(err, /Invalid value for --limit: expected number >= 1; received 0/);
  const big = await gbot("/nonexistent", "codex", "list-threads", "--limit", "201");
  assert.match(big.err, /Invalid value for --limit: expected number <= 200; received 201/);
});

test("codex send resumes the thread, starts a turn, and prints the ids", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "hello", "from", "gbot", "--json");
    assert.equal(code, 0, out);
    const receipt = JSON.parse(out);
    assert.match(receipt.messageId, /^[0-9a-f-]{36}$/);
    assert.equal(receipt.correlationId, receipt.messageId);
    assert.deepEqual(receipt, {
      delivery: "accepted",
      threadId: "t-1",
      threadStatus: "idle",
      turnId: "turn-9",
      turnStatus: "inProgress",
      model: "gpt-6",
      cwd: "/repo/a",
      approvalPolicy: "never",
      messageId: receipt.messageId,
      correlationId: receipt.messageId,
      hop: 0,
      maxHops: 4,
      exitCode: 0,
    });
    assert.deepEqual(fake.received.map((m) => m.method), ["initialize", "initialized", "thread/resume", "turn/start"]);
    assert.deepEqual(fake.received[2].params, { threadId: "t-1", excludeTurns: true });
    // Plain sends keep the body verbatim; the id rides Codex's native clientUserMessageId.
    assert.deepEqual(fake.received[3].params, {
      threadId: "t-1",
      input: [{ type: "text", text: "hello from gbot" }],
      clientUserMessageId: receipt.messageId,
      turnTrigger: "gbot",
    });

    const text = await gbot(fake.home, "codex", "send", "t-1", "again");
    assert.match(text.out, /^Started turn turn-9 \(inProgress\) on Codex thread t-1; message [0-9a-f-]{36}\n$/);
  } finally {
    await fake.close();
  }
});

test("codex send explains unknown threads and threads owned by another client", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const unknown = await gbot(fake.home, "codex", "send", "nope", "hi");
    assert.equal(unknown.code, 1);
    assert.equal(unknown.out, "Unknown Codex thread nope. Run `gbot codex list-threads` to see reachable threads.\n");

    const busy = await gbot(fake.home, "codex", "send", "t-2", "hi");
    assert.equal(busy.code, 1);
    assert.match(busy.out, /^Codex thread t-2 is open in another client/);
    assert.equal(fake.received.filter((m) => m.method === "turn/start").length, 0);
  } finally {
    await fake.close();
  }
});

test("codex send refuses server approval requests and fails with guidance", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send) => {
      send({ jsonrpc: "2.0", id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId, command: "rm -rf /" } });
      setTimeout(() => ok({ turn: { id: "turn-10", status: "inProgress", items: [] } }), 50);
    },
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "do it");
    assert.equal(code, 1);
    assert.match(out, /^Turn turn-10 started on thread t-1 but Codex asked for item\/commandExecution\/requestApproval, which gbot refused/);
    assert.match(out, /approval_policy = "never"/);
    const refusal = fake.received.find((m) => m.id === "srv-1");
    assert.equal(refusal.error.code, -32601);
    assert.equal(refusal.result, undefined);
  } finally {
    await fake.close();
  }
});

test("codex send returns once the turn starts; later approval requests are the daemon's to route", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send) => {
      ok({ turn: { id: "turn-11", status: "inProgress", items: [] } });
      setTimeout(() => send({ jsonrpc: "2.0", id: "srv-2", method: "item/commandExecution/requestApproval", params: {} }), 20);
    },
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "go");
    assert.equal(code, 0);
    assert.match(out, /^Started turn turn-11 \(inProgress\) on Codex thread t-1; message /);
  } finally {
    await fake.close();
  }
});

test("codex send fails fast when the server sends a Close frame mid-request", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send, socket) => socket.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]))),
  });
  try {
    const started = Date.now();
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "go");
    assert.equal(code, 1);
    assert.match(out, /^Lost the Codex turn\/start response for thread t-1: Codex app-server closed the connection\./);
    assert.match(out, /Delivery is unknown; check the thread before resending\./);
    assert.ok(Date.now() - started < 5000, "did not wait for the request timeout");
  } finally {
    await fake.close();
  }
});

test("codex send reserves --json and protects flag-like message text after --", async () => {  const fake = await fakeAppServer(baseHandlers);
  try {
    const json = await gbot(fake.home, "codex", "send", "t-1", "explain", "--json", "output");
    assert.equal(json.code, 0);
    assert.equal(JSON.parse(json.out).exitCode, 0);
    assert.equal(fake.received.findLast((m) => m.method === "turn/start").params.input[0].text, "explain output");

    const text = await gbot(fake.home, "codex", "send", "t-1", "--", "explain", "--json", "--dir", "src");
    assert.equal(text.code, 0);
    assert.match(text.out, /Started turn/);
    assert.equal(fake.received.findLast((m) => m.method === "turn/start").params.input[0].text, "explain --json --dir src");
  } finally {
    await fake.close();
  }
});

test("codex list-threads strips terminal controls from names and previews", async () => {
  const handlers = {
    ...baseHandlers,
    "thread/list": (params, ok) =>
      ok({
        data: [
          {
            id: "t-evil",
            status: { type: "idle" },
            name: "Build\u001b[31mRED\u001b[0m\rOVERWRITE",
            preview: "hi\u001b]0;owned\u0007 there\b\bXX",
            cwd: "/repo\u0007",
            source: "cli",
            updatedAt: 1,
          },
        ],
        nextCursor: null,
      }),
  };
  const fake = await fakeAppServer(handlers);
  try {
    const { code, out } = await gbot(fake.home, "codex", "list-threads");
    assert.equal(code, 0);
    assert.match(out, /BuildREDOVERWRITE/);
    assert.doesNotMatch(out, /\u001b/);
    assert.doesNotMatch(out, /\]0;owned/);
    assert.doesNotMatch(out, /\r/);
    assert.doesNotMatch(out, /\u0008/);
    assert.doesNotMatch(out, /\u0007/);
    assert.match(out, /hi thereXX/);
  } finally {
    await fake.close();
  }
});

test("codex send reassembles a fragmented turn/start reply split across TCP chunks", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send, socket) => {
      void ok;
      void err;
      const id = fake.received.at(-1).id;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { turn: { id: "turn-9", status: "inProgress", items: [] } } }));
      const half = Math.floor(payload.length / 2);
      const first = Buffer.concat([Buffer.from([0x01, half]), payload.subarray(0, half)]);
      const second = Buffer.concat([Buffer.from([0x80, payload.length - half]), payload.subarray(half)]);
      socket.write(first.subarray(0, 3));
      setTimeout(() => socket.write(Buffer.concat([first.subarray(3), second])), 20);
    },
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "go", "--json");
    assert.equal(code, 0, out);
    assert.deepEqual(JSON.parse(out).turnId, "turn-9");
  } finally {
    await fake.close();
  }
});

test("codex status fails on a wrong handshake and closes the socket instead of leaking it", async () => {  const home = mkdtempSync(join(tmpdir(), "gbot-codex-badhs-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  let serverSocket = null;
  const server = createTcpServer((sock) => {
    serverSocket = sock;
    sock.on("data", () => sock.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
    sock.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const closed = new Promise((resolve) => server.on("connection", (sock) => sock.on("close", resolve)));
  try {
    const started = Date.now();
    const { code, out } = await gbot(home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.reachable, false);
    assert.equal(status.mode, "handshake-failed");
    assert.match(status.message, /refused the WebSocket upgrade/);
    assert.ok(Date.now() - started < 5000, "failed fast instead of hanging");
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("client socket leaked")), 3000))]);
    assert.ok(serverSocket.destroyed || serverSocket.closed, "server side sees the client go away");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("codex status fails fast on an oversized frame and settles the pending request", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    initialize: (params, ok, err, send, socket) => {
      void params; void ok; void err; void send;
      socket.write(Buffer.from([0x81, 0x7f, 0, 0, 0, 0, 0x10, 0, 0, 0]));
    },
  });
  try {
    const started = Date.now();
    const { code, out } = await gbot(fake.home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.mode, "handshake-failed");
    assert.match(status.message, /exceeds/);
    assert.ok(Date.now() - started < 5000, "did not wait for the request timeout");
  } finally {
    await fake.close();
  }
});

test("client close is idempotent and settles pending requests", async () => {
  const fake = await fakeAppServer({ ...baseHandlers, "turn/start": () => {} });
  const socketPath = join(fake.home, "app-server-control", "app-server-control.sock");
  try {
    const client = await connectCodexAppServer(socketPath);
    const pending = client.request("turn/start", { threadId: "t-1", input: [] });
    const settled = assert.rejects(pending, /closed/);
    client.close();
    client.close();
    await settled;
  } finally {
    await fake.close();
  }
});

test("codex send keeps the thread id and reports unknown delivery on a malformed ack", async () => {
  const fake = await fakeAppServer({ ...baseHandlers, "turn/start": (params, ok) => ok({ turn: { status: "inProgress" } }) });
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "go");
    assert.equal(code, 1);
    assert.match(out, /malformed turn\/start acknowledgment for thread t-1/);
    assert.match(out, /unknown/);
  } finally {
    await fake.close();
  }
});

test("codex send ignores server requests scoped to other threads", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "thread/resume": (params, ok, err, send) => {
      send({ jsonrpc: "2.0", id: "srv-other", method: "item/commandExecution/requestApproval", params: { threadId: "other" } });
      baseHandlers["thread/resume"](params, ok, err);
    },
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "go", "--json");
    assert.equal(code, 0, out);
    assert.equal(JSON.parse(out).delivery, "accepted");
  } finally {
    await fake.close();
  }
});

test("codex send preserves turn and thread ids with accepted delivery on refusal", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send) => {
      send({ jsonrpc: "2.0", id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId } });
      setTimeout(() => ok({ turn: { id: "turn-10", status: "inProgress", items: [] } }), 20);
    },
  });
  const home = fake.home;
  const env = { ...process.env, CODEX_HOME: home };
  try {
    const outcome = await sendToCodexThread("t-1", "do it", { env });
    assert.equal(outcome.delivery, "accepted");
    assert.equal(outcome.reason, "approval-refused");
    assert.equal(outcome.threadId, "t-1");
    assert.equal(outcome.turnId, "turn-10");
    assert.equal(outcome.exitCode, 1);
  } finally {
    await fake.close();
  }
});

test("a JSON null message fails as malformed instead of crashing on msg.id", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    initialize: (params, ok, err, send) => {
      void params; void ok; void err;
      send(null);
    },
  });
  try {
    const started = Date.now();
    const { code, out } = await gbot(fake.home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.mode, "handshake-failed");
    assert.match(status.message, /malformed message/);
    assert.ok(Date.now() - started < 5000, "did not hang on the bad message");
  } finally {
    await fake.close();
  }
});

test("handshake timeout is absolute; trickled bytes do not extend it", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-trickle-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const server = createTcpServer((sock) => {
    sock.on("data", () => {
      const t = setInterval(() => sock.write("X"), 50);
      sock.on("close", () => clearInterval(t));
    });
    sock.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const started = Date.now();
    await assert.rejects(connectCodexAppServer(socketPath, { timeoutMs: 300 }), /Timed out connecting/);
    assert.ok(Date.now() - started < 5000, "absolute deadline fired instead of waiting on the trickle");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("codex status rejects terminated oversized handshake headers", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-bighdr-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const server = createTcpServer((sock) => {
    sock.on("data", () => sock.write("HTTP/1.1 101 Switching Protocols\r\nX-Pad: " + "y".repeat(20000) + "\r\n\r\n"));
    sock.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const started = Date.now();
    const { code, out } = await gbot(home, "codex", "status");
    assert.equal(code, 1);
    assert.match(out, /reachable: no \(handshake-failed\)/);
    assert.match(out, /exceed/);
    assert.ok(Date.now() - started < 5000, "failed fast instead of decoding the headers");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("codex status rejects a complete oversized frame without buffering it", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    initialize: (params, ok, err, send, socket) => {
      void params; void ok; void err; void send;
      socket.write(encodeFrame(0x1, Buffer.alloc(5 * 1024 * 1024)));
    },
  });
  try {
    const started = Date.now();
    const { code, out } = await gbot(fake.home, "codex", "status");
    assert.equal(code, 1);
    assert.match(out, /reachable: no \(handshake-failed\)/);
    assert.match(out, /exceed/);
    assert.ok(Date.now() - started < 5000, "failed fast instead of buffering the frame");
  } finally {
    await fake.close();
  }
});

test("codex send emits structured JSON errors with delivery and ids", async () => {  const fake = await fakeAppServer(baseHandlers);
  try {
    const unknown = await gbot(fake.home, "codex", "send", "nope", "hi", "--json");
    assert.equal(unknown.code, 1);
    const failure = JSON.parse(unknown.out);
    assert.match(failure.messageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(failure, {
      error: "Unknown Codex thread nope. Run `gbot codex list-threads` to see reachable threads.",
      delivery: "rejected",
      reason: "unknown-thread",
      threadId: "nope",
      messageId: failure.messageId,
      correlationId: failure.messageId,
      hop: 0,
      exitCode: 1,
    });
    assert.equal(unknown.err, "");
  } finally {
    await fake.close();
  }
  const refusing = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send) => {
      send({ jsonrpc: "2.0", id: "srv-1", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId } });
      setTimeout(() => ok({ turn: { id: "turn-10", status: "inProgress", items: [] } }), 20);
    },
  });
  try {
    const { code, out } = await gbot(refusing.home, "codex", "send", "t-1", "do it", "--json");
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.delivery, "accepted");
    assert.equal(parsed.threadId, "t-1");
    assert.equal(parsed.turnId, "turn-10");
    assert.match(parsed.error, /^Turn turn-10 started on thread t-1/);
  } finally {
    await refusing.close();
  }
});

test("codex send parses a trailing --json as a flag", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const trailing = await gbot(fake.home, "codex", "send", "t-1", "hi", "--json");
    assert.equal(trailing.code, 0, trailing.err);
    assert.equal(JSON.parse(trailing.out).turnId, "turn-9");
    assert.equal(fake.received.at(-1).params.input[0].text, "hi");

    // Leading globals were a hand-CLI habit; the Agent Bundle CLI rejects them.
    const leading = await gbot(fake.home, "--json", "codex", "send", "t-1", "hi");
    assert.notEqual(leading.code, 0);
    assert.match(leading.err, /Unknown option: --json/);
  } finally {
    await fake.close();
  }
});

test("codex send keeps a --json protected by -- as message content", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, out } = await gbot(fake.home, "codex", "send", "t-1", "--", "--json");
    assert.equal(code, 0, out);
    assert.match(out, /^Started turn turn-9/);
    assert.equal(fake.received.at(-1).params.input[0].text, "--json");
  } finally {
    await fake.close();
  }
});

test("codex send failures honor a trailing --json with structured errors", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, err, out } = await gbot(fake.home, "codex", "send", "nope", "hi", "--json");
    assert.equal(code, 1);
    assert.equal(err, "");
    const failure = JSON.parse(out);
    assert.equal(failure.reason, "unknown-thread");
    assert.equal(failure.delivery, "rejected");
    assert.equal(failure.threadId, "nope");
    assert.match(failure.messageId, /^[0-9a-f-]{36}$/);
  } finally {
    await fake.close();
  }
});

// ---- #39: machine-readable status and thread discovery ----

test("codex status distinguishes permission-denied and stale files from an absent socket", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-perm-"));
  mkdirSync(join(home, "app-server-control"), { mode: 0o000 });
  try {
    const denied = await gbot(home, "codex", "status", "--json");
    assert.equal(denied.code, 1);
    const status = JSON.parse(denied.out);
    assert.equal(status.reachable, false);
    assert.equal(status.mode, "permission-denied");
    assert.equal(status.socketState, "permission-denied");
    assert.match(status.message, /may not access it/);
  } finally {
    chmodSync(join(home, "app-server-control"), 0o700);
  }
  writeFileSync(join(home, "app-server-control", "app-server-control.sock"), "stale");
  const stale = await gbot(home, "codex", "status", "--json");
  assert.equal(JSON.parse(stale.out).mode, "not-a-socket");
  assert.equal(JSON.parse(stale.out).socketState, "not-a-socket");
});

test("codex status reports connect-failed when the socket exists but nothing answers", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-dead-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const server = createTcpServer((sock) => sock.destroy());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const { code, out } = await gbot(home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.reachable, false);
    assert.equal(status.socketState, "socket");
    assert.equal(status.mode, "connect-failed");
    assert.equal(status.desktopAttached, "unknown");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("codex status separates schema compatibility from reachability and bounds the CLI probe", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    initialize: (params, ok) => ok({ userAgent: "codex/0.160.0 (linux) client (" + params.clientInfo.name + ")", codexHome: 7 }),
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "status", "--json");
    assert.equal(code, 0, out);
    const status = JSON.parse(out);
    assert.equal(status.reachable, true);
    assert.deepEqual(status.schema, { pinned: "0.154.0", daemon: "0.160.0", compatibility: "unverified" });
    assert.equal(status.codexHome, null, "non-string codexHome is not passed through");
    assert.equal(status.cliVersionProbe, "missing", "PATH has no codex binary");
    assert.equal(status.desktopAttached, "unknown");
    const text = await gbot(fake.home, "codex", "status");
    assert.match(text.out, /pinned schema: 0\.154\.0 \(unverified\)/);
    assert.match(text.out, /desktop attached: unknown/);
  } finally {
    await fake.close();
  }
});

test("codex status times out a hung codex --version probe instead of hanging", async () => {
  const bin = mkdtempSync(join(tmpdir(), "gbot-codex-bin-"));
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-nosock-"));
  const started = Date.now();
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [CLI, "codex", "status", "--json"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: home, PATH: bin } }, (error, out) => resolve({ code: error ? error.code : 0, out }));
  });
  assert.ok(Date.now() - started < 10000, "probe was bounded");
  const status = JSON.parse(result.out);
  assert.equal(status.cliVersion, null);
  assert.equal(status.cliVersionProbe, "timeout");
});

test("codex status rejects unknown arguments before touching the socket", async () => {
  const { code, err } = await gbot("/nonexistent", "codex", "status", "--verbose");
  assert.equal(code, 2);
  assert.match(err, /^Unknown option: --verbose\./);
});

test("codex list-threads pages with --cursor, echoes nextCursor, and rejects unknown args", async () => {
  const seen = [];
  const fake = await fakeAppServer({
    ...baseHandlers,
    "thread/list": (params, ok) => {
      seen.push(params);
      if (params.cursor === "page-2") return ok({ data: [THREADS[1]], nextCursor: null });
      ok({ data: [THREADS[0]], nextCursor: "page-2\u001b[31m" });
    },
  });
  try {
    const first = await gbot(fake.home, "codex", "list-threads", "--limit", "1", "--json");
    assert.equal(first.code, 0, first.err);
    const page = JSON.parse(first.out);
    assert.equal(page.nextCursor, "page-2\u001b[31m", "JSON keeps the opaque cursor verbatim");
    assert.equal(page.limit, 1);
    const text = await gbot(fake.home, "codex", "list-threads", "--limit", "1");
    assert.match(text.out, /more: --cursor "page-2"\n$/, "text output strips controls from the cursor and quotes it");
    assert.doesNotMatch(text.out, /\u001b/);

    const second = await gbot(fake.home, "codex", "list-threads", "--limit", "1", "--cursor", "page-2", "--json");
    assert.deepEqual(JSON.parse(second.out).threads.map((t) => t.id), ["t-2"]);
    assert.equal(JSON.parse(second.out).nextCursor, null);
    assert.deepEqual(seen.at(-1), { limit: 1, useStateDbOnly: true, cursor: "page-2" });

    const unknown = await gbot(fake.home, "codex", "list-threads", "--all");
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /^Unknown option: --all\./);
    const empty = await gbot(fake.home, "codex", "list-threads", "--cursor");
    assert.match(empty.err, /--cursor requires a value/);
  } finally {
    await fake.close();
  }
});

test("codex list-threads fails with bad-response when the daemon returns an unknown shape", async () => {
  const fake = await fakeAppServer({ ...baseHandlers, "thread/list": (params, ok) => ok({ threads: [] }) });
  try {
    const { code, out } = await gbot(fake.home, "codex", "list-threads", "--json");
    assert.equal(code, 1);
    const failure = JSON.parse(out);
    assert.equal(failure.reason, "bad-response");
    assert.equal(failure.exitCode, 1);
    assert.match(failure.error, /unexpected thread\/list response: missing `data` array/);
    assert.match(failure.error, /pinned to app-server schema 0\.154\.0/);
  } finally {
    await fake.close();
  }
});

test("codex list-threads sanitizes text fields, keeps structured source, and rejects idless entries", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "thread/list": (params, ok) => ok({
      data: [
        { id: "t-\u001b[2Jx\nline", status: { type: "active", activeFlags: ["waitingOnApproval\u0007"] }, name: "a\tb", preview: "keep\nnewlines\u001b[31m", cwd: "/r\u001b]0;x\u0007", source: { custom: "hauler\u001b[0m" }, updatedAt: "soon" },
        { id: "t-odd", status: { type: "somethingNew" }, source: "cli\r" },
      ],
      nextCursor: null,
    }),
  });
  try {
    const { code, out } = await gbot(fake.home, "codex", "list-threads", "--json");
    assert.equal(code, 0);
    const { threads } = JSON.parse(out);
    assert.deepEqual(threads, [
      { id: "t-x line", status: "active", activeFlags: ["waitingOnApproval"], name: "a b", preview: "keep\nnewlines", cwd: "/r", source: { custom: "hauler\u001b[0m" }, updatedAt: null },
      { id: "t-odd", status: "unknown", activeFlags: [], name: null, preview: "", cwd: null, source: "cli", updatedAt: null },
    ]);
  } finally {
    await fake.close();
  }
  const broken = await fakeAppServer({ ...baseHandlers, "thread/list": (params, ok) => ok({ data: [{ status: { type: "idle" } }], nextCursor: null }) });
  try {
    const { code, out } = await gbot(broken.home, "codex", "list-threads", "--json");
    assert.equal(code, 1);
    assert.equal(JSON.parse(out).reason, "bad-response");
    assert.match(JSON.parse(out).error, /entry without a string `id`/);
  } finally {
    await broken.close();
  }
});

// ---- #37: attributable routes and loop-safe correlation ----

test("codex send carries correlation and reply metadata, prepends the header, and bounds hops", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const reply = await gbot(fake.home, "codex", "send", "--correlation-id", "corr-1", "--reply-to", "msg-0", "--hop", "1", "--json", "--", "t-1", "on it", "--dir", "src");
    assert.equal(reply.code, 0, reply.err);
    const receipt = JSON.parse(reply.out);
    assert.equal(receipt.correlationId, "corr-1");
    assert.equal(receipt.replyTo, "msg-0");
    assert.equal(receipt.hop, 1);
    assert.notEqual(receipt.messageId, "corr-1");
    const start = fake.received.findLast((m) => m.method === "turn/start");
    assert.equal(start.params.clientUserMessageId, receipt.messageId);
    const [header, ...body] = start.params.input[0].text.split("\n");
    assert.match(header, new RegExp("^\\[gbot msg=" + receipt.messageId + " corr=corr-1 reply-to=msg-0 hop=1 from=[^\\s\\]]+\\]$"));
    assert.equal(body.join("\n"), "on it --dir src", "mid-message tokens stay message content");

    const looped = await gbot(fake.home, "codex", "send", "--correlation-id", "corr-1", "--reply-to", "msg-3", "--hop", "4", "t-1", "ack", "--json");
    assert.equal(looped.code, 1);
    const refusal = JSON.parse(looped.out);
    assert.equal(refusal.delivery, "rejected");
    assert.equal(refusal.reason, "hop-limit");
    assert.equal(refusal.correlationId, "corr-1");
    assert.match(refusal.error, /relay bound 4 \(GROK_BOT_MAX_HOPS\)/);
    assert.equal(fake.received.filter((m) => m.method === "turn/start").length, 1, "hop-limit refusals never reach the daemon");

    const orphan = await gbot(fake.home, "codex", "send", "--reply-to", "msg-0", "t-1", "hi", "--json");
    assert.equal(orphan.code, 1);
    assert.equal(JSON.parse(orphan.out).reason, "usage");
    assert.match(JSON.parse(orphan.out).error, /--reply-to needs the original --correlation-id/);
    const badId = await gbot(fake.home, "codex", "send", "--correlation-id", "has space", "t-1", "hi", "--json");
    assert.equal(JSON.parse(badId.out).reason, "usage");
    assert.match(JSON.parse(badId.out).error, /--correlation-id must be 1-128 characters/);
    const badHop = await gbot(fake.home, "codex", "send", "--hop", "-1", "t-1", "hi", "--json");
    assert.equal(badHop.code, 2);
    const badHopError = JSON.parse(badHop.err).error;
    assert.equal(badHopError.code, "CLI_INPUT_INVALID");
    assert.equal(badHopError.issues[0].target, "--hop");
  } finally {
    await fake.close();
  }
});

test("GROK_BOT_MAX_HOPS and --envelope are honored; operator allowlist rejects other threads", async () => {
  const fake = await fakeAppServer(baseHandlers);
  const run = (env, ...args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: fake.home, PATH: "/nonexistent", ...env } }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
  });
  try {
    const tight = await run({ GROK_BOT_MAX_HOPS: "1" }, "codex", "send", "--hop", "1", "t-1", "x", "--json");
    assert.equal(JSON.parse(tight.out).reason, "hop-limit");
    const loose = await run({ GROK_BOT_MAX_HOPS: "9" }, "codex", "send", "--hop", "8", "t-1", "x", "--json");
    assert.equal(loose.code, 0, loose.err);
    assert.equal(JSON.parse(loose.out).maxHops, 9);

    const enveloped = await run({}, "codex", "send", "--envelope", "t-1", "plain", "--json");
    assert.equal(enveloped.code, 0, enveloped.err);
    const start = fake.received.findLast((m) => m.method === "turn/start");
    assert.match(start.params.input[0].text, /^\[gbot msg=[0-9a-f-]{36} corr=[0-9a-f-]{36} hop=0 from=[^\]]+\]\nplain$/);

    const blocked = await run({ GROK_BOT_CODEX_THREADS: "t-9, t-8" }, "codex", "send", "t-1", "x", "--json");
    assert.equal(blocked.code, 1);
    const refusal = JSON.parse(blocked.out);
    assert.equal(refusal.reason, "route-not-allowed");
    assert.equal(refusal.delivery, "rejected");
    assert.match(refusal.error, /operator allows only: t-9, t-8/);
    const before = fake.received.length;
    const allowed = await run({ GROK_BOT_CODEX_THREADS: "t-1" }, "codex", "send", "t-1", "x", "--json");
    assert.equal(allowed.code, 0, allowed.err);
    assert.ok(fake.received.length > before);
  } finally {
    await fake.close();
  }
});

test("codex send reports an unavailable route as a structured rejected receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-noroute-"));
  const { code, out } = await gbot(home, "codex", "send", "t-1", "hello", "--json");
  assert.equal(code, 1);
  const failure = JSON.parse(out);
  assert.equal(failure.delivery, "rejected");
  assert.equal(failure.reason, "socket-absent");
  assert.equal(failure.mode, "socket-absent");
  assert.match(failure.error, /No Codex app-server control socket/);
});

// ---- #38: busy-thread delivery ----

test("codex send refuses active and systemError threads without steering them", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "thread/resume": (params, ok) => ok({
      thread: {
        id: params.threadId,
        status: params.threadId === "t-busy" ? { type: "active", activeFlags: ["waitingOnUserInput"] } : { type: "systemError" },
      },
      model: "gpt-6",
      cwd: "/repo",
      approvalPolicy: "never",
    }),
  });
  try {
    const busy = await gbot(fake.home, "codex", "send", "t-busy", "hi", "--json");
    assert.equal(busy.code, 1);
    const refusal = JSON.parse(busy.out);
    assert.equal(refusal.delivery, "rejected");
    assert.equal(refusal.reason, "busy");
    assert.equal(refusal.threadId, "t-busy");
    assert.match(refusal.error, /active turn \(waitingOnUserInput\); sending now would steer that turn/);

    const broken = await gbot(fake.home, "codex", "send", "t-err", "hi", "--json");
    assert.equal(JSON.parse(broken.out).reason, "thread-error");
    assert.equal(fake.received.filter((m) => m.method === "turn/start").length, 0, "no turn/start, turn/steer, or turn/interrupt was sent");
    assert.equal(fake.received.filter((m) => /steer|interrupt/.test(m.method)).length, 0);
  } finally {
    await fake.close();
  }
});

test("codex send distinguishes external-owner, unknown-thread, and transport reasons", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const owned = JSON.parse((await gbot(fake.home, "codex", "send", "t-2", "hi", "--json")).out);
    assert.equal(owned.reason, "external-owner");
    assert.equal(owned.delivery, "rejected");
    const unknown = JSON.parse((await gbot(fake.home, "codex", "send", "nope", "hi", "--json")).out);
    assert.equal(unknown.reason, "unknown-thread");
  } finally {
    await fake.close();
  }
  const dropping = await fakeAppServer({
    ...baseHandlers,
    "turn/start": (params, ok, err, send, socket) => socket.destroy(),
  });
  try {
    const lost = JSON.parse((await gbot(dropping.home, "codex", "send", "t-1", "hi", "--json")).out);
    assert.equal(lost.delivery, "unknown");
    assert.equal(lost.reason, "transport");
    assert.match(lost.messageId, /^[0-9a-f-]{36}$/, "the receipt names the message to look for before resending");
  } finally {
    await dropping.close();
  }
});

// ---- review follow-ups: classification, envelopes, injection, queue ----

test("codex status classifies initialize failures as handshake-failed and off-schema init as bad-response", async () => {
  const rejecting = await fakeAppServer({ initialize: (params, ok, err) => err({ code: -32000, message: "nope" }) });
  try {
    const status = JSON.parse((await gbot(rejecting.home, "codex", "status", "--json")).out);
    assert.equal(status.reachable, false);
    assert.equal(status.mode, "handshake-failed");
    assert.match(status.message, /initialize failed: Codex app-server rejected initialize: nope/);
  } finally {
    await rejecting.close();
  }
  const offSchema = await fakeAppServer({ initialize: (params, ok) => ok("not-an-object") });
  try {
    const { code, out } = await gbot(offSchema.home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.reachable, true, "the endpoint answered");
    assert.equal(status.mode, "bad-response");
  } finally {
    await offSchema.close();
  }
});

test("codex status reports permission-denied when connect fails with EACCES", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-codex-eacces-"));
  mkdirSync(join(home, "app-server-control"));
  const socketPath = join(home, "app-server-control", "app-server-control.sock");
  const server = createTcpServer((sock) => sock.destroy());
  await new Promise((resolve) => server.listen(socketPath, resolve));
  chmodSync(socketPath, 0o000);
  try {
    const { code, out } = await gbot(home, "codex", "status", "--json");
    assert.equal(code, 1);
    const status = JSON.parse(out);
    assert.equal(status.socketState, "socket");
    assert.equal(status.mode, "permission-denied");
  } finally {
    chmodSync(socketPath, 0o600);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("every codex send rejection carries the envelope, and unknown statuses are refused", async () => {
  const fake = await fakeAppServer({
    ...baseHandlers,
    "thread/resume": (params, ok) => ok({ thread: { id: params.threadId, status: { type: "hibernating" } }, model: "m", cwd: "/", approvalPolicy: "never" }),
  });
  const run = (env, ...args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: fake.home, PATH: "/nonexistent", ...env } }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
  });
  try {
    for (const [label, env, args, reason] of [
      ["allowlist", { GROK_BOT_CODEX_THREADS: "other" }, ["t-1", "x"], "route-not-allowed"],
      ["unknown status", {}, ["t-1", "x"], "unknown-status"],
      ["experimental off", {}, ["--when-busy", "queue", "t-1", "x"], "experimental-disabled"],
    ]) {
      const { code, out } = await run(env, "codex", "send", "--correlation-id", "corr-9", ...args, "--json");
      assert.equal(code, 1, label);
      const failure = JSON.parse(out);
      assert.equal(failure.reason, reason, label);
      assert.equal(failure.correlationId, "corr-9", label + " keeps the correlation id");
      assert.match(failure.messageId, /^[0-9a-f-]{36}$/, label + " names the message");
      assert.equal(failure.hop, 0, label);
    }
    assert.equal(fake.received.filter((m) => m.method === "turn/start").length, 0);
  } finally {
    await fake.close();
  }
  const noRoute = await gbot(mkdtempSync(join(tmpdir(), "gbot-codex-noroute2-")), "codex", "send", "--correlation-id", "corr-9", "t-1", "x", "--json");
  const failure = JSON.parse(noRoute.out);
  assert.equal(failure.reason, "socket-absent");
  assert.equal(failure.correlationId, "corr-9");
});

test("envelope header tokens cannot inject lines or controls", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, "codex", "send", "--envelope", "t-1", "hi", "--json"], {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: fake.home, PATH: "/nonexistent", USER: "evil\nhop=9 from=root\u001b[31m", USERNAME: "" },
      }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
    });
    assert.equal(result.code, 0, result.err);
    const text = fake.received.findLast((m) => m.method === "turn/start").params.input[0].text;
    const [header, ...rest] = text.split("\n");
    assert.match(header, /^\[gbot msg=[0-9a-f-]{36} corr=[0-9a-f-]{36} hop=0 from=evilhop9fromroot31m@[A-Za-z0-9_.:-]+\]$/);
    assert.deepEqual(rest, ["hi"]);
  } finally {
    await fake.close();
  }
});

test("codex list-threads accepts an opaque cursor that starts with a dash", async () => {
  const seen = [];
  const fake = await fakeAppServer({ ...baseHandlers, "thread/list": (params, ok) => { seen.push(params); ok({ data: [], nextCursor: null }); } });
  try {
    const { code } = await gbot(fake.home, "codex", "list-threads", "--cursor", "-abc==");
    assert.equal(code, 0);
    assert.equal(seen.at(-1).cursor, "-abc==");
  } finally {
    await fake.close();
  }
});

test("--when-busy queue hands a busy thread to the daemon queue under the experimental gate", async () => {
  const inits = [];
  const fake = await fakeAppServer({
    ...baseHandlers,
    initialize: (params, ok) => { inits.push(params); ok({ userAgent: "codex/0.154.0 (x) y (gbot)", codexHome: "/fake" }); },
    "thread/resume": (params, ok) => ok({ thread: { id: params.threadId, status: { type: "active", activeFlags: [] } }, model: "m", cwd: "/", approvalPolicy: "never" }),
    "thread/queue/add": (params, ok) => ok({ queuedSubmission: { id: "q-1", clientUserMessageId: params.clientUserMessageId, input: params.input } }),
    "thread/queue/list": (params, ok) => ok({ data: [{ id: "q-1", clientUserMessageId: "m-1", input: [{ type: "text", text: "queued\u001b[31m body" }] }], nextCursor: null }),
  });
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, CODEX_HOME: fake.home, PATH: "/nonexistent", GROK_BOT_CODEX_EXPERIMENTAL: "1" } }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
  });
  try {
    const { code, out } = await run("codex", "send", "--when-busy", "queue", "t-1", "later please", "--json");
    assert.equal(code, 0, out);
    const receipt = JSON.parse(out);
    assert.equal(receipt.delivery, "queued");
    assert.equal(receipt.queuedSubmissionId, "q-1");
    assert.equal(receipt.threadStatus, "active");
    assert.match(receipt.messageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(inits.at(-1).capabilities, { experimentalApi: true });
    const add = fake.received.find((m) => m.method === "thread/queue/add");
    assert.equal(add.params.clientUserMessageId, receipt.messageId);
    assert.equal(add.params.input[0].text, "later please");
    assert.equal(fake.received.filter((m) => /turn\/(start|steer|interrupt)/.test(m.method)).length, 0);

    const queue = await run("codex", "queue", "t-1", "--json");
    assert.equal(queue.code, 0, queue.err);
    assert.deepEqual(JSON.parse(queue.out), { threadId: "t-1", queued: [{ id: "q-1", clientUserMessageId: "m-1", text: "queued\u001b[31m body" }], nextCursor: null, exitCode: 0 });
    const text = await run("codex", "queue", "t-1");
    assert.doesNotMatch(text.out, /\u001b/);
  } finally {
    await fake.close();
  }
  const old = await fakeAppServer({
    ...baseHandlers,
    "thread/resume": (params, ok) => ok({ thread: { id: params.threadId, status: { type: "active", activeFlags: [] } }, model: "m", cwd: "/", approvalPolicy: "never" }),
  });
  try {
    const { code, out } = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, "codex", "send", "--when-busy", "queue", "t-1", "x", "--json"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: old.home, PATH: "/nonexistent", GROK_BOT_CODEX_EXPERIMENTAL: "1" } }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out).reason, "unsupported");
  } finally {
    await old.close();
  }
});
