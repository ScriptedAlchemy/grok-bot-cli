import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as bridge from "../src/core/codex-bridge.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const frame = message => bridge.encodeFrame(1, Buffer.from(JSON.stringify(message)));
async function peer(t, { initial = [], initialize = { userAgent: "codex/0.154.0" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gbot-session-"));
  const path = join(dir, "sock");
  const server = createServer();
  const sockets = new Set();
  const received = [];
  let socket;
  server.on("upgrade", (req, connection) => {
    socket = connection;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(connection));
    socket.write(Buffer.concat([Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + bridge.websocketAccept(req.headers["sec-websocket-key"]) + "\r\n\r\n"), ...initial.map(frame)]));
    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const decoded = bridge.decodeFrame(buf);
        if (!decoded) return;
        buf = decoded.rest;
        if (decoded.opcode === 8) { socket.end(); return; }
        if (decoded.opcode !== 1) continue;
        const message = JSON.parse(decoded.payload.toString());
        received.push(message);
        if (message.method === "initialize") socket.write(frame({ id: message.id, result: initialize }));
        if (message.method === "echo") socket.write(frame({ id: message.id, result: message.params }));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const connection of sockets) connection.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, received, get socket() { return socket; }, send: (...messages) => socket.write(Buffer.concat(messages.map(frame))) };
}
async function connected(t, options, peerOptions) {
  const p = await peer(t, peerOptions);
  const client = await bridge.connectCodexAppServer(p.path, { timeoutMs: 100, ...options });
  t.after(() => client.close());
  return { p, client };
}

test("notifications preserve batching order, construction hooks, and unsubscribe", async t => {
  const seen = [];
  const { p, client } = await connected(t, { onNotification: m => seen.push(m) }, { initial: [{ method: "early" }] });
  const later = [];
  const off = client.onNotification(m => later.push(m));
  p.send({ method: "turn/started" }, { method: "turn/completed" });
  await tick();
  assert.deepEqual(seen.map(m => m.method), ["early", "turn/started", "turn/completed"]);
  assert.deepEqual(later.map(m => m.method), ["turn/started", "turn/completed"]);
  off(); off();
  p.send({ method: "later" });
  await tick();
  assert.equal(later.length, 2);
});

test("server requests allow one explicit result or error and resolved IDs cannot be answered", async t => {
  const { p, client } = await connected(t);
  client.onServerRequest(m => {
    if (m.id === "result") client.respond(m.id, { decision: "decline" });
    if (m.id === "error") client.rejectRequest(m.id, { code: -32601, message: "unsupported" });
  });
  p.send({ id: "result", method: "approval" }, { id: "error", method: "input" }, { id: "resolved", method: "approval" }, { method: "serverRequest/resolved", params: { requestId: "resolved" } });
  await tick();
  assert.deepEqual(p.received.map(m => m.id), ["result", "error"]);
  assert.deepEqual(p.received[0].result, { decision: "decline" });
  assert.equal(p.received[1].error.code, -32601);
  for (const id of ["result", "error", "resolved", "unknown"]) assert.throws(() => client.respond(id, {}), /pending|resolved|unknown/i);
});

test("passive observers leave foreign approvals silent", async t => {
  const { p, client } = await connected(t);
  const seen = [];
  client.onServerRequest(m => seen.push(m));
  client.answerServerRequests = true;
  client.expectedThreadId = "ours";
  client.expectedTurnId = "our-turn";
  p.send({ id: 1, method: "approval", params: { threadId: "foreign", turnId: "other" } });
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(p.received.length, 0);
});

test("idle survives RPC deadline but disconnect closes once and rejects future requests", async t => {
  const { p, client } = await connected(t, { timeoutMs: 20 });
  const closes = [];
  client.onClose(e => closes.push(e));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(client.closed, false);
  assert.deepEqual(await client.request("echo", { healthy: true }), { healthy: true });
  const closed = new Promise(resolve => client.onClose(resolve));
  p.socket.destroy();
  assert.match((await closed).message, /closed|disconnect|socket/i);
  await assert.rejects(client.request("thread/list", {}), /closed|disconnect|socket/i);
  client.close();
  assert.equal(closes.length, 1);
  let late;
  client.onClose(e => { late = e; });
  assert.equal(late, closes[0]);
});

test("abort clears pending operations and signal listeners", async t => {
  const controller = new AbortController();
  const { client } = await connected(t, { signal: controller.signal });
  const pending = assert.rejects(client.request("wait", {}), /abort/i);
  const closed = new Promise(resolve => client.onClose(resolve));
  controller.abort();
  await pending;
  assert.match((await closed).message, /abort/i);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.throws(() => client.notify("later"), /abort|closed/i);
});

test("throwing event listeners close cleanly without process exceptions", async t => {
  const { p, client } = await connected(t);
  const closed = new Promise(resolve => client.onClose(resolve));
  client.onClose(() => { throw new Error("close observer"); });
  client.onNotification(() => { throw new Error("broken observer"); });
  p.send({ method: "event" }, { method: "ignored-after-close" });
  assert.match((await closed).message, /listener|observer/i);
  assert.equal(client.closed, true);
});

test("outgoing frames and nonreading peer pressure fail within an absolute byte budget", async t => {
  const { p, client } = await connected(t);
  p.socket.pause();
  const closed = new Promise(resolve => client.onClose(resolve));
  let writes = 0;
  assert.throws(() => {
    for (; writes < 20; writes++) client.notify("bulk", { text: "x".repeat(1024 * 1024) });
  }, /write|outbound|budget/i);
  assert.ok(writes < 20);
  assert.match((await closed).message, /write|outbound|budget/i);
  const next = await connected(t);
  assert.throws(() => next.client.notify("huge", { text: "x".repeat(8 * 1024 * 1024) }), /write|outbound|budget/i);
});

test("client requests, server history, deferred approvals and listeners have finite limits", async t => {
  const first = await connected(t);
  const requests = Array.from({ length: 129 }, () => first.client.request("wait", {}).catch(e => e));
  const errors = await Promise.all(requests);
  assert.ok(errors.every(e => /limit|bound|128/i.test(e.message)));
  const second = await connected(t);
  const closed = new Promise(resolve => second.client.onClose(resolve));
  second.client.answerServerRequests = true;
  second.client.expectedThreadId = "ours";
  second.p.send(...Array.from({ length: 129 }, (_, id) => ({ id, method: "approval", params: { threadId: "ours", turnId: "unknown-yet" } })));
  assert.match((await closed).message, /limit|bound|128/i);
  assert.ok(second.client.refused.length <= 128);
  assert.equal(second.client.deferred.length, 0);
  const third = await connected(t);
  for (let i = 0; i < 128; i++) third.client.onNotification(() => {});
  assert.throws(() => third.client.onNotification(() => {}), /limit|bound|128/i);
});

test("timeout validation and pre-aborted connections fail before connecting", async t => {
  const p = await peer(t);
  for (const timeoutMs of [0, -1, Infinity, NaN, 0.5, 2 ** 31]) {
    await assert.rejects(async () => bridge.connectCodexAppServer(p.path, { timeoutMs }), /timeoutMs/i);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(bridge.connectCodexAppServer(p.path, { signal: controller.signal }), /abort/i);
});

test("openCodexSession initializes with capabilities and initial hooks", async t => {
  assert.equal(typeof bridge.openCodexSession, "function");
  const p = await peer(t, { initial: [{ method: "early" }] });
  const seen = [];
  const { client, path, init } = await bridge.openCodexSession({ CODEX_APP_SERVER_SOCK: p.path }, { timeoutMs: 100, experimental: true, onNotification: m => seen.push(m) });
  t.after(() => client.close());
  await tick();
  assert.equal(path, p.path);
  assert.equal(init.userAgent, "codex/0.154.0");
  assert.equal(seen[0].method, "early");
  assert.equal(p.received[0].params.capabilities.experimentalApi, true);
  assert.equal(p.received[0].params.clientInfo.name, "gbot");
  assert.equal(p.received[1].method, "initialized");
});

test("resolution invalidates deferred ownership before turn adoption", async t => {
  const { p, client } = await connected(t);
  client.answerServerRequests = true;
  client.expectedThreadId = "ours";
  p.send({ id: "gone", method: "approval", params: { threadId: "ours", turnId: "turn" } }, { method: "serverRequest/resolved", params: { requestId: "gone", threadId: "ours" } });
  await tick();
  client._adoptTurn("turn");
  await tick();
  assert.equal(p.received.length, 0);
  assert.throws(() => client.rejectRequest("gone", { code: -1, message: "late" }), /resolved|unknown/i);
});

test("RPC timeout releases capacity while local close disposes all pending work", async t => {
  const controller = new AbortController();
  const { client } = await connected(t, { timeoutMs: 20, signal: controller.signal });
  await assert.rejects(client.request("wait", {}), /within 20ms/);
  assert.equal(client.closed, false);
  assert.equal(await client.request("echo", "still-alive"), "still-alive");
  const rejection = assert.rejects(client.request("wait", {}), /closed/);
  const closed = new Promise(resolve => client.onClose(resolve));
  client.close();
  await rejection;
  assert.match((await closed).message, /closed/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("async observer rejections close the transport and close rejections are consumed", async t => {
  const { p, client } = await connected(t, { onClose: async () => { throw new Error("close failed"); } });
  const closed = new Promise(resolve => client.onClose(resolve));
  client.onServerRequest(async () => { throw new Error("async observer failed"); });
  p.send({ id: 1, method: "approval" });
  assert.match((await closed).message, /async observer failed/);
  await tick();
});

test("initialization validation closes the socket and notifies initial close hooks", async t => {
  const p = await peer(t, { initialize: null });
  const errors = [];
  const controller = new AbortController();
  await assert.rejects(bridge.openCodexSession({ CODEX_APP_SERVER_SOCK: p.path }, { timeoutMs: 50, signal: controller.signal, onClose: error => errors.push(error) }), /result is not an object/);
  assert.equal(errors.length, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await tick();
  assert.equal(p.socket.destroyed, true);
});

test("a single stalled outbound write has an absolute drain deadline", { timeout: 500 }, async t => {
  const { p, client } = await connected(t, { timeoutMs: 25 });
  p.socket.pause();
  const closed = new Promise(resolve => client.onClose(resolve));
  client.notify("bulk", { text: "x".repeat(4 * 1024 * 1024) });
  assert.match((await closed).message, /write|drain/i);
  assert.equal(client.closed, true);
});
