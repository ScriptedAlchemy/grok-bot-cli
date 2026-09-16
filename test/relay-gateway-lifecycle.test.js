import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { openRelayEngine } from "../src/core/relay/engine.js";
import { fakeAppServer } from "./helpers/codex-server.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t, kind, phase) {
  const dir = await fs.mkdtemp("/tmp/relay-gateway-cancel-");
  const entered = deferred(),
    release = deferred();
  const prompts = [],
    items = new Map();
  let engine,
    armed = false,
    held = false;
  const sending = () =>
    armed &&
    engine
      .status()
      .receipts.some((r) => r.kind === kind && r.delivery === "sending");
  async function hold() {
    held = true;
    entered.resolve();
    await release.promise;
  }
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    let response;
    if (req.url.endsWith("/EnsureSandBox")) {
      if (!held && phase === "auth" && sending()) await hold();
      response = {
        gatewayUrl: `http://127.0.0.1:${server.address().port}`,
        gatewayToken: "fixture-gateway-token",
      };
    } else if (req.url === "/api/listAgents") {
      if (!held && phase === "resolve" && sending()) await hold();
      response = {
        agents: [
          { id: "target-a", name: "A" },
          { id: "target-b", name: "B" },
        ],
      };
    } else if (req.url === "/api/sendPrompt") {
      prompts.push(body);
      if (!held && phase.startsWith("written") && sending()) await hold();
      response =
        phase === "written-unknown" && body.agentId === "target-a"
          ? {}
          : { messageId: `message-${prompts.length}` };
    } else response = { entries: [] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) =>
      ok({ thread: { id: p.threadId, cwd: "/tmp", status: { type: "idle" } } }),
    "thread/turns/list": (p, ok) =>
      ok({
        data: items.has(p.threadId)
          ? [{ id: "turn-" + p.threadId, status: "completed" }]
          : [],
        nextCursor: null,
      }),
    "thread/items/list": (p, ok) =>
      ok({
        data: (items.get(p.threadId) ?? []).map((item) => ({
          turnId: "turn-" + p.threadId,
          item,
        })),
        nextCursor: null,
      }),
    "turn/start": (p, ok) => {
      items.set(p.threadId, [
        {
          id: "user-" + p.threadId,
          type: "userMessage",
          clientId: p.clientUserMessageId,
        },
        {
          id: "answer-" + p.threadId,
          type: "agentMessage",
          phase: "final_answer",
          text: "fixture final",
        },
      ]);
      ok({ turn: { id: "turn-" + p.threadId, status: "inProgress" } });
    },
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = {
    HOME: join(dir, "private-home"),
    USERPROFILE: join(dir, "private-home"),
    XDG_CONFIG_HOME: join(dir, "private-home", ".config"),
    APPDATA: join(dir, "private-home", "AppData"),
    GROK_BOT_TEST: "1",
    NODE_ENV: "test",
    GROK_BOT_GATEWAY_URL: url,
    GROK_BOT_GATEWAY_TOKEN: "fixture-gateway-token",
    GROK_BOT_GATEWAY_HEADERS: "",
    CURSOR_API_BASE_URL: url,
    SAND_BACKEND_URL: url,
    CURSOR_ACCESS_TOKEN: "fixture-access-token",
    SAND_HOST_GATEWAY_URL: "",
    SAND_HOST_GATEWAY_TOKEN: "",
    SAND_GATEWAY_TOKEN: "",
    GROK_BOT_ACCESS_TOKEN: "",
    SAND_ACCESS_TOKEN: "",
    CODEX_HOME: fake.home,
    CODEX_APP_SERVER_SOCK: "",
    GROK_BOT_CODEX_THREADS: "",
    GROK_BOT_MAX_HOPS: "4",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const originalChmod = fs.chmod;
  t.after(async () => {
    release.resolve();
    fs.chmod = originalChmod;
    syncBuiltinESMExports();
    await engine?.close();
    await fake.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const options = {
    stateDir: join(dir, "state"),
    profile: "gateway-cancel-fixture",
  };
  engine = await openRelayEngine(options);
  const a = await engine.startBinding({
    grokTarget: "A",
    codexThreadId: "thread-a",
  });
  const b = await engine.startBinding({
    grokTarget: "B",
    codexThreadId: "thread-b",
  });
  fs.chmod = async (...args) => {
    await originalChmod(...args);
    if (!held && phase === "persist" && sending()) await hold();
  };
  syncBuiltinESMExports();
  return {
    get engine() {
      return engine;
    },
    a,
    b,
    prompts,
    fake,
    entered,
    release,
    async start() {
      if (kind === "grok-return")
        await engine.sendToCodex({
          bindingId: a.id,
          message: "produce final",
          requestId: "return-source",
        });
      if (phase === "auth") process.env.GROK_BOT_GATEWAY_TOKEN = "";
      armed = true;
      return kind === "grok-request"
        ? engine.sendToGrok({
            bindingId: a.id,
            message: "stop this request",
            requestId: "cancelled-request",
          })
        : engine.tick();
    },
    async reopen() {
      engine = await openRelayEngine(options);
    },
  };
}

for (const kind of ["grok-request", "grok-return"])
  for (const stop of ["binding", "engine"])
    for (const phase of [
      "persist",
      "auth",
      "resolve",
      "written-accepted",
      "written-unknown",
    ]) {
      test(
        `${kind}: ${stop} cancellation during ${phase} preserves transmission certainty and another binding`,
        { timeout: 10000 },
        async (t) => {
          const f = await fixture(t, kind, phase);
          const pending = f.start();
          pending.catch(() => {});
          await f.entered.promise;
          const stopping =
            stop === "binding"
              ? f.engine.stopBinding({ bindingId: f.a.id })
              : f.engine.close();
          f.release.resolve();
          await Promise.all([stopping, pending]);
          const receipt = f.engine
            .status()
            .receipts.find((r) => r.kind === kind);
          const expected =
            phase === "written-accepted"
              ? "accepted"
              : phase === "written-unknown"
                ? "unknown"
                : "rejected";
          assert.equal(receipt?.delivery, expected);
          if (!phase.startsWith("written"))
            assert.equal(receipt.reason, "cancelled");
          assert.equal(f.prompts.length, phase.startsWith("written") ? 1 : 0);
          assert.equal(
            f.fake.received.filter((x) => x.method === "turn/interrupt").length,
            0,
          );
          if (stop === "engine") await f.reopen();
          const persisted = f.engine
            .status()
            .receipts.find((r) => r.exchangeId === receipt.exchangeId);
          assert.equal(persisted.delivery, expected);
          const other = await f.engine.sendToGrok({
            bindingId: f.b.id,
            message: "other binding remains usable",
            requestId: "other-send",
          });
          assert.equal(other.delivery, "accepted");
          assert.equal(f.prompts.at(-1).agentId, "target-b");
        },
      );
    }
