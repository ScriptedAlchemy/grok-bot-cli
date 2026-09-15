import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { decodeFrame, encodeFrame, websocketAccept } from "../src/codex-bridge.js";

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
  const server = createServer();
  server.on("upgrade", (req, socket) => {
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
  return { home, received, close: () => new Promise((resolve) => server.close(resolve)) };
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
    assert.equal(err, "Codex app-server closed the connection\n");
    assert.ok(Date.now() - started < 5000, "did not wait for the request timeout");
  } finally {
    await fake.close();
  }
});

test("codex send surfaces other JSON-RPC errors verbatim", async () => {
  const fake = await fakeAppServer({ ...baseHandlers, "turn/start": (params, ok, err) => err({ code: -32600, message: "model unavailable" }) });
  try {
    const { code, err } = await gbot(fake.home, "codex", "send", "t-1", "hi");
    assert.equal(code, 1);
    assert.equal(err, "Codex app-server rejected turn/start: model unavailable\n");
  } finally {
    await fake.close();
  }
});
