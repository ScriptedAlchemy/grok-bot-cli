import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeFrame, encodeFrame, websocketAccept, connectCodexAppServer, sendToCodexThread, CodexSendError } from "../src/codex-bridge.js";
import { createServer as createTcpServer } from "node:net";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

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
  const { code, out } = await gbot(home, "--json", "codex", "status");
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
    const { code, out } = await gbot(fake.home, "--json", "codex", "status");
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
    assert.equal(text.out, "t-1  idle - Fix the build\n    /repo/a\n    please fix the build\n");
    assert.deepEqual(fake.received.find((m) => m.method === "thread/list").params, { limit: 1, useStateDbOnly: true });

    const json = await gbot(fake.home, "--json", "codex", "list-threads");
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), {
      threads: [
        { id: "t-1", status: "idle", name: "Fix the build", preview: "please fix the build", cwd: "/repo/a", source: "vscode", updatedAt: 1700000001 },
        { id: "t-2", status: "notLoaded", name: null, preview: "second   thread\npreview", cwd: "/repo/b", source: "cli", updatedAt: 1700000000 },
      ],
      nextCursor: null,
    });
    assert.deepEqual(fake.received.at(-1).params, { limit: 20, useStateDbOnly: true });
  } finally {
    await fake.close();
  }
});

test("codex list-threads rejects a bad --limit", async () => {
  const { code, err } = await gbot("/nonexistent", "codex", "list-threads", "--limit", "0");
  assert.equal(code, 1);
  assert.equal(err, "--limit must be a positive integer\n");
});

test("codex send resumes the thread, starts a turn, and prints the ids", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, out } = await gbot(fake.home, "--json", "codex", "send", "t-1", "hello", "from", "gbot");
    assert.equal(code, 0, out);
    assert.deepEqual(JSON.parse(out), {
      delivery: "accepted",
      threadId: "t-1",
      turnId: "turn-9",
      turnStatus: "inProgress",
      model: "gpt-6",
      cwd: "/repo/a",
      approvalPolicy: "never",
    });
    assert.deepEqual(fake.received.map((m) => m.method), ["initialize", "initialized", "thread/resume", "turn/start"]);
    assert.deepEqual(fake.received[2].params, { threadId: "t-1", excludeTurns: true });
    assert.deepEqual(fake.received[3].params, { threadId: "t-1", input: [{ type: "text", text: "hello from gbot" }] });

    const text = await gbot(fake.home, "codex", "send", "t-1", "again");
    assert.equal(text.out, "Started turn turn-9 (inProgress) on Codex thread t-1\n");
  } finally {
    await fake.close();
  }
});

test("codex send explains unknown threads and threads owned by another client", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const unknown = await gbot(fake.home, "codex", "send", "nope", "hi");
    assert.equal(unknown.code, 1);
    assert.equal(unknown.err, "Unknown Codex thread nope. Run `gbot codex list-threads` to see reachable threads.\n");

    const busy = await gbot(fake.home, "codex", "send", "t-2", "hi");
    assert.equal(busy.code, 1);
    assert.match(busy.err, /^Codex thread t-2 is open in another client/);
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
    const { code, err } = await gbot(fake.home, "codex", "send", "t-1", "do it");
    assert.equal(code, 1);
    assert.match(err, /^Turn turn-10 started on thread t-1 but Codex asked for item\/commandExecution\/requestApproval, which gbot refused/);
    assert.match(err, /approval_policy = "never"/);
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
    assert.equal(out, "Started turn turn-11 (inProgress) on Codex thread t-1\n");
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
    const { code, err } = await gbot(fake.home, "codex", "send", "t-1", "go");
    assert.equal(code, 1);
    assert.match(err, /^Lost the Codex turn\/start response for thread t-1: Codex app-server closed the connection\./);
    assert.match(err, /Delivery is unknown; check the thread before resending\./);
    assert.ok(Date.now() - started < 5000, "did not wait for the request timeout");
  } finally {
    await fake.close();
  }
});

test("codex send keeps --json / --dir tokens that appear after the thread id", async () => {  const fake = await fakeAppServer(baseHandlers);
  try {
    const { code, out } = await gbot(
      fake.home,
      "codex",
      "send",
      "t-1",
      "explain",
      "--json",
      "output",
      "and",
      "--dir",
      "src",
    );
    assert.equal(code, 0);
    assert.match(out, /Started turn/);
    const start = fake.received.find((m) => m.method === "turn/start");
    assert.equal(start.params.input[0].text, "explain --json output and --dir src");
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
    const { code, out } = await gbot(fake.home, "--json", "codex", "send", "t-1", "go");
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
    const { code, err } = await gbot(home, "codex", "status");
    assert.equal(code, 1);
    assert.match(err, /refused the WebSocket upgrade/);
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
    const { code, err } = await gbot(fake.home, "codex", "status");
    assert.equal(code, 1);
    assert.match(err, /exceeds/);
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
    const { code, err } = await gbot(fake.home, "codex", "send", "t-1", "go");
    assert.equal(code, 1);
    assert.match(err, /malformed turn\/start acknowledgment for thread t-1/);
    assert.match(err, /unknown/);
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
    const { code, out } = await gbot(fake.home, "--json", "codex", "send", "t-1", "go");
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
    await assert.rejects(sendToCodexThread("t-1", "do it", env), (e) => {
      assert.ok(e instanceof CodexSendError);
      assert.equal(e.delivery, "accepted");
      assert.equal(e.threadId, "t-1");
      assert.equal(e.turnId, "turn-10");
      return true;
    });
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
    const { code, err } = await gbot(fake.home, "codex", "status");
    assert.equal(code, 1);
    assert.match(err, /malformed message/);
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
    const { code, err } = await gbot(home, "codex", "status");
    assert.equal(code, 1);
    assert.match(err, /exceed/);
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
    const { code, err } = await gbot(fake.home, "codex", "status");
    assert.equal(code, 1);
    assert.match(err, /exceed/);
    assert.ok(Date.now() - started < 5000, "failed fast instead of buffering the frame");
  } finally {
    await fake.close();
  }
});

test("codex send emits structured JSON errors with delivery and ids", async () => {
  const fake = await fakeAppServer(baseHandlers);
  try {
    const unknown = await gbot(fake.home, "--json", "codex", "send", "nope", "hi");
    assert.equal(unknown.code, 1);
    assert.deepEqual(JSON.parse(unknown.err), {
      error: "Unknown Codex thread nope. Run `gbot codex list-threads` to see reachable threads.",
      delivery: "rejected",
      threadId: "nope",
    });
    assert.equal(unknown.out, "");
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
    const { code, err } = await gbot(refusing.home, "--json", "codex", "send", "t-1", "do it");
    assert.equal(code, 1);
    const parsed = JSON.parse(err);
    assert.equal(parsed.delivery, "accepted");
    assert.equal(parsed.threadId, "t-1");
    assert.equal(parsed.turnId, "turn-10");
    assert.match(parsed.error, /^Turn turn-10 started on thread t-1/);
  } finally {
    await refusing.close();
  }
});
