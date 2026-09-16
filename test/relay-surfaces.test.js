import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, lstat, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { fakeAppServer } from "./helpers/codex-server.js";
import { relayRequest } from "../src/core/relay/control.js";

export async function fixture({ active = false, interaction, onGateway } = {}) {
  const calls = [];
  const entries = [];
  const gateway = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const value = JSON.parse(body);
    calls.push({ path: req.url, value });
    await onGateway?.(req.url, value);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url.endsWith("listAgents")
          ? {
              agents: [
                { id: "bot-1", name: "General" },
                { id: "bot-2", name: "Alice" },
              ],
            }
          : req.url.endsWith("getAgentTranscriptTail")
            ? { entries }
            : req.url.endsWith("sendPrompt")
              ? { messageId: "grok-1" }
              : {},
      ),
    );
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const fake = await fakeAppServer({
    initialize: (_, ok) => ok({}),
    "thread/resume": (p, ok) =>
      ok({
        thread: {
          id: p.threadId,
          cwd: "/tmp",
          status: { type: active ? "active" : "idle" },
        },
      }),
    "thread/turns/list": (_, ok) =>
      ok({
        data: active ? [{ id: "turn-1", status: "inProgress" }] : [],
        nextCursor: null,
      }),
    "thread/items/list": (_, ok) => ok({ data: [], nextCursor: null }),
    "turn/start": (p, ok, _error, send) => {
      ok({ turn: { id: "turn-1", status: "inProgress" } });
      if (interaction)
        setTimeout(
          () =>
            send({
              jsonrpc: "2.0",
              id: "operator-1",
              method:
                interaction === "question"
                  ? "item/tool/requestUserInput"
                  : "item/commandExecution/requestApproval",
              params: {
                threadId: p.threadId,
                turnId: "turn-1",
                ...(interaction === "question"
                  ? {
                      questions: [
                        {
                          id: "choice",
                          header: "Choice",
                          question: "Pick one",
                          isSecret: false,
                        },
                      ],
                    }
                  : {
                      availableDecisions: ["decline"],
                      command: "echo fixture",
                    }),
              },
            }),
          10,
        );
    },
    "turn/steer": (p, ok) => ok({ turnId: p.expectedTurnId }),
  });
  const dir = await mkdtemp("/tmp/relay packed state ");
  const env = {
    ...process.env,
    GROK_BOT_TEST: "1",
    CODEX_HOME: fake.home,
    CODEX_APP_SERVER_SOCK: "",
    GROK_BOT_CODEX_THREADS: "",
    GROK_BOT_MAX_HOPS: "4",
    GROK_BOT_RELAY_DIR: dir,
    GROK_BOT_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`,
    GROK_BOT_GATEWAY_TOKEN: "fixture-token",
    GROK_BOT_GATEWAY_HEADERS: "",
    CODEX_THREAD_ID: "stale-env-thread",
  };
  return {
    env,
    calls,
    entries,
    fake,
    close: async () => {
      await relayRequest({ env }, "stop", { worker: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      await fake.close();
      await new Promise((r) => gateway.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function mcp(
  root,
  env,
  name = "cursor",
  manifestPath = process.env.RELAY_MCP_MANIFEST ?? "mcp.json",
) {
  const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8"));
  const launch = manifest.mcpServers["grok-bot"];
  const expand = (value) =>
    value.replace(
      /\$\{(?:PLUGIN_ROOT|CURSOR_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}/g,
      root,
    );
  const child = spawn(process.execPath, launch.args.map(expand), {
    cwd: resolve(root, expand(launch.cwd ?? root)),
    env: {
      ...env,
      ...Object.fromEntries(
        Object.entries(launch.env ?? {}).map(([key, value]) => [
          key,
          expand(value),
        ]),
      ),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "",
    seq = 0,
    stderr = "";
  const pending = new Map();
  child.stderr.on("data", (x) => (stderr += x));
  child.stdout.on("data", (x) => {
    buf += x;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(Error(`MCP timeout ${stderr}`));
      }, 20000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name, version: "1" },
    capabilities: {},
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  return {
    rpc,
    close: async () => {
      child.kill();
      await once(child, "exit");
    },
    call: async (name, args, thread) => {
      const r = await rpc("tools/call", {
        name,
        arguments: args,
        ...(thread
          ? {
              _meta: {
                "x-codex-turn-metadata": {
                  thread_id: thread,
                  session_id: thread,
                  turn_id: "native-turn",
                },
              },
            }
          : {}),
      });
      assert.equal(r.result?.isError, undefined, JSON.stringify(r));
      return r.result.structuredContent;
    },
  };
}

test(
  "generated MCP native send survives caller; unavailable and inferred sources remain manual; explicit return routes use worker",
  { timeout: 90000 },
  async () => {
    const f = await fixture();
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
        "codex-mcp-client",
      );
      const names = (await client.rpc("tools/list", {})).result.tools.map(
        (t) => t.name,
      );
      for (const name of [
        "gbot_bridge_start",
        "gbot_bridge_status",
        "gbot_bridge_stop",
      ])
        assert.ok(names.includes(name), name);
      assert.ok(!names.includes("gbot_codex_respond"));
      const manual = await client.call("gbot_send", {
        target: "General",
        message: "manual",
      });
      assert.deepEqual(manual.replyRoute, {
        mode: "manual",
        reason: "source-unavailable",
      });
      assert.equal(manual.delivery, "accepted");
      const sent = await client.call(
        "gbot_send",
        { target: "General", message: "native" },
        "thread-native",
      );
      assert.equal(sent.replyRoute.mode, "auto");
      assert.equal(sent.replyRoute.threadId, "thread-native");
      assert.equal(sent.execution, "pending");
      assert.equal(sent.target.id, "bot-1");
      assert.equal(sent.delivery, "accepted");
      assert.ok(sent.exchangeId);
      const pid = sent.worker.pid;
      await client.close();
      client = null;
      const status = await relayRequest({ env: f.env }, "status", {});
      assert.equal(status.worker.pid, pid);
      assert.equal(status.receipts.length, 1);
      const nonce = f.calls.filter((x) => x.path.endsWith("sendPrompt")).at(-1)
        .value.clientNonce;
      f.entries.push(
        {
          id: "native-user",
          kind: "message",
          role: "user",
          clientNonce: nonce,
          requestId: "actual-native-request",
          text: "native",
        },
        {
          id: "native-reply",
          kind: "send-message",
          requestId: "actual-native-request",
          text: "reply after caller exit",
        },
      );
      for (
        let i = 0;
        i < 100 && !f.fake.received.some((x) => x.method === "turn/start");
        i++
      )
        await new Promise((r) => setTimeout(r, 50));
      const delivered = f.fake.received.find((x) => x.method === "turn/start");
      assert.equal(delivered?.params.threadId, "thread-native");
      assert.match(JSON.stringify(delivered), /reply after caller exit/);
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
        "cursor",
      );
      const inferred = await client.call(
        "gbot_send",
        { target: "General", message: "cursor" },
        "thread-inferred",
      );
      assert.equal(inferred.replyRoute.mode, "manual");
      const bound = await client.call("gbot_bridge_start", {
        grokTarget: "General",
        codexThreadId: "thread-native",
        expectedCwd: "/tmp",
      });
      assert.equal(bound.binding.state, "running");
      assert.equal(bound.worker.pid, pid);
      const returned = await client.call("codex_send", {
        threadId: "thread-native",
        message: "return please",
        replyToGrok: "General",
        expectedCwd: "/tmp",
      });
      assert.equal(returned.delivery, "accepted");
      assert.equal(returned.replyRoute.mode, "auto");
      assert.equal(returned.execution, "pending");
      await client.call("gbot_bridge_stop", { bindingId: bound.binding.id });
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        3,
      );
    } finally {
      await client?.close();
      await f.close();
    }
  },
);
const cli = (env, ...args) =>
  new Promise((resolveResult) =>
    execFile(
      process.execPath,
      [
        resolve(process.env.RELAY_CLI_ROOT ?? "dist", "bin/gbot.mjs"),
        ...args,
        "--json",
      ],
      { env },
      (error, out, err) => resolveResult({ code: error?.code ?? 0, out, err }),
    ),
  );
test(
  "CLI concurrent starts share one owner, durable request replay sends once, worker restart retains receipt",
  { timeout: 90000 },
  async () => {
    const f = await fixture();
    try {
      const args = [
        "codex",
        "bridge",
        "start",
        "--codex-thread-id",
        "thread-cli",
        "--expected-cwd",
        "/tmp",
        "--request-id",
        "stable-binding",
        "General",
      ];
      const results = await Promise.all([
        cli(f.env, ...args),
        cli(f.env, ...args),
      ]);
      for (const r of results) assert.equal(r.code, 0, r.err + r.out);
      const [a, b] = results.map((r) => JSON.parse(r.out));
      assert.equal(a.worker.pid, b.worker.pid);
      assert.equal(a.binding.id, b.binding.id);
      const sendArgs = [
        "send",
        "--reply-mode",
        "auto",
        "--binding-id",
        a.binding.id,
        "--request-id",
        "stable-send",
        "General",
        "hello",
      ];
      for (let i = 0; i < 2; i++) {
        const r = await cli(f.env, ...sendArgs);
        assert.equal(r.code, 0, r.err + r.out);
        assert.equal(JSON.parse(r.out).delivery, "accepted");
      }
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        1,
      );
      await relayRequest({ env: f.env }, "stop", { worker: true });
      await new Promise((r) => setTimeout(r, 150));
      const dead = await cli(f.env, "codex", "bridge", "status");
      assert.equal(JSON.parse(dead.out).worker.state, "stopped");
      const replay = await cli(f.env, ...sendArgs);
      assert.equal(replay.code, 0, replay.err + replay.out);
      assert.equal(JSON.parse(replay.out).delivery, "accepted");
      assert.notEqual(JSON.parse(replay.out).worker.pid, a.worker.pid);
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        1,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "foreground CLI remains alive until chosen lifetime and releases socket ownership",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const started = Date.now();
    try {
      const result = await cli(
        f.env,
        "codex",
        "bridge",
        "run",
        "--lifetime-ms",
        "600",
      );
      assert.equal(result.code, 0, result.out + result.err);
      assert.ok(Date.now() - started >= 600);
      assert.equal(JSON.parse(result.out).state, "stopped");
      await assert.rejects(
        lstat(join(f.env.GROK_BOT_RELAY_DIR, "control.sock")),
        (error) => error.code === "ENOENT",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "plain packaged worker handles SIGTERM and crash recovery without losing durable receipts",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          resolve(
            process.env.RELAY_ARTIFACT_ROOT ?? "artifact",
            "scripts/gbot-relay.mjs",
          ),
        ],
        { env: f.env, stdio: "ignore" },
      );
      let ready;
      for (let i = 0; i < 100; i++) {
        try {
          ready = await relayRequest({ env: f.env }, "hello", {});
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      assert.equal(ready?.worker.pid, child.pid);
      const sent = await relayRequest(
        { env: f.env },
        "sendToGrok",
        {
          grokTarget: "General",
          codexThreadId: "thread-crash",
          message: "once",
        },
        { requestId: "crash-stable" },
      );
      assert.equal(sent.delivery, "accepted");
      child.kill("SIGKILL");
      await once(child, "exit");
      child = null;
      const restart = await cli(
        f.env,
        "send",
        "--reply-mode",
        "auto",
        "--codex-thread-id",
        "thread-crash",
        "--request-id",
        "crash-stable",
        "General",
        "once",
      );
      assert.equal(restart.code, 0, restart.err + restart.out);
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        1,
      );
      const status = await relayRequest({ env: f.env }, "status", {});
      process.kill(status.worker.pid, "SIGTERM");
      for (let i = 0; i < 100; i++) {
        try {
          await lstat(join(f.env.GROK_BOT_RELAY_DIR, "control.sock"));
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          break;
        }
      }
      await assert.rejects(
        lstat(join(f.env.GROK_BOT_RELAY_DIR, "control.sock")),
        (error) => error.code === "ENOENT",
      );
    } finally {
      child?.kill();
      await f.close();
    }
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  test(
    `foreground CLI ${signal} stops observation and releases ownership`,
    { timeout: 15000 },
    async () => {
      const f = await fixture();
      const child = spawn(
        process.execPath,
        [
          resolve(process.env.RELAY_CLI_ROOT ?? "dist", "bin/gbot.mjs"),
          "codex",
          "bridge",
          "run",
          "--lifetime-ms",
          "10000",
          "--json",
        ],
        { env: f.env, stdio: "ignore" },
      );
      try {
        let ready;
        for (let i = 0; i < 100; i++) {
          try {
            ready = await relayRequest({ env: f.env }, "hello", {});
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        assert.ok(ready);
        child.kill(signal);
        await once(child, "exit");
        for (let i = 0; i < 100; i++) {
          try {
            await lstat(join(f.env.GROK_BOT_RELAY_DIR, "control.sock"));
            await new Promise((r) => setTimeout(r, 25));
          } catch {
            break;
          }
        }
        await assert.rejects(
          lstat(join(f.env.GROK_BOT_RELAY_DIR, "control.sock")),
          (error) => error.code === "ENOENT",
        );
        assert.equal(
          f.fake.received.filter((x) => x.method === "turn/interrupt").length,
          0,
        );
      } finally {
        child.kill();
        await f.close();
      }
    },
  );
test(
  "requested automatic routes fail closed before send on missing source, wrong cwd or profile mismatch",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let client, restricted;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      for (const args of [
        { target: "General", message: "missing source", replyMode: "auto" },
        {
          target: "General",
          message: "wrong cwd",
          codexThreadId: "thread-1",
          expectedCwd: "/not-the-thread-workspace",
        },
      ]) {
        const r = await client.rpc("tools/call", {
          name: "gbot_send",
          arguments: args,
        });
        assert.equal(r.result.isError, true, JSON.stringify(r));
      }
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        0,
      );
      restricted = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        { ...f.env, GROK_BOT_CODEX_THREADS: "other-thread" },
      );
      const mismatch = await restricted.rpc("tools/call", {
        name: "gbot_send",
        arguments: {
          target: "General",
          message: "profile mismatch",
          codexThreadId: "thread-1",
        },
      });
      assert.equal(mismatch.result.isError, true);
      assert.match(JSON.stringify(mismatch), /profile mismatch/i);
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        0,
      );
      const manual = await client.call(
        "gbot_send",
        { target: "General", message: "explicit manual", replyMode: "manual" },
        "native-thread",
      );
      assert.deepEqual(manual.replyRoute, {
        mode: "manual",
        reason: "requested",
      });
    } finally {
      await restricted?.close();
      await client?.close();
      await f.close();
    }
  },
);
test(
  "codex return refuses a binding belonging to another explicit thread",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      const bound = await client.call("gbot_bridge_start", {
        grokTarget: "General",
        codexThreadId: "thread-bound",
      });
      const response = await client.rpc("tools/call", {
        name: "codex_send",
        arguments: {
          threadId: "thread-other",
          message: "do not misroute",
          bindingId: bound.binding.id,
        },
      });
      assert.equal(response.result.isError, true, JSON.stringify(response));
      assert.equal(
        f.fake.received.filter((x) => x.method === "turn/start").length,
        0,
      );
    } finally {
      await client?.close();
      await f.close();
    }
  },
);
test(
  "copied host artifacts resolve a verified bundled worker without development package files",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp("/tmp/relay copied plugin ");
    const f = await fixture();
    let client;
    try {
      await cp(process.env.RELAY_ARTIFACT_ROOT ?? resolve("artifact"), root, {
        recursive: true,
      });
      const manifest = JSON.parse(
        await readFile(join(root, "agent-bundle.manifest.json"), "utf8"),
      );
      const worker = manifest.executables.scripts.find(
        (x) => x.path === "scripts/gbot-relay.mjs",
      );
      assert.deepEqual([...worker.hosts].sort(), [
        "claude",
        "codex",
        "cursor",
        "portable",
      ]);
      let pid;
      for (const [host, path] of [
        ["codex-mcp-client", ".codex-plugin/mcp.json"],
        ["cursor", ".cursor-plugin/mcp.json"],
        ["claude-code", ".mcp.json"],
        ["portable", "mcp.json"],
      ]) {
        client = await mcp(root, f.env, host, path);
        const out = await client.call("gbot_send", {
          target: "General",
          message: "from " + host,
          codexThreadId: "thread-copy",
        });
        assert.equal(out.delivery, "accepted");
        assert.equal(out.replyRoute.threadId, "thread-copy");
        pid ??= out.worker.pid;
        assert.equal(out.worker.pid, pid);
        await client.close();
        client = null;
      }
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        4,
      );
    } finally {
      await client?.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
test(
  "managed codex_send defaults to guarded steering for an active thread",
  { timeout: 15000 },
  async () => {
    const f = await fixture({ active: true });
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      const out = await client.call("codex_send", {
        threadId: "thread-active",
        message: "deliver while working",
        replyToGrok: "General",
      });
      assert.equal(out.delivery, "accepted");
      assert.equal(
        f.fake.received.find((x) => x.method === "turn/steer")?.params
          .expectedTurnId,
        "turn-1",
      );
      assert.equal(
        f.fake.received.filter((x) => x.method === "turn/start").length,
        0,
      );
    } finally {
      await client?.close();
      await f.close();
    }
  },
);
for (const interaction of ["approval", "question"])
  test(
    `generated operator ${interaction} response is scoped, explicit and single-use`,
    { timeout: 20000 },
    async () => {
      const f = await fixture({ interaction });
      let client;
      try {
        client = await mcp(
          resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
          f.env,
        );
        const sent = await client.call("codex_send", {
          threadId: "thread-operator",
          message: "request operator input",
          replyToGrok: "General",
        });
        let item;
        for (let i = 0; i < 30 && !item; i++) {
          const status = await client.call("gbot_bridge_status", {});
          item = status.interactions[0];
          if (!item) await new Promise((r) => setTimeout(r, 25));
        }
        assert.ok(item);
        assert.equal(
          f.fake.received.filter((x) => x.id === "operator-1").length,
          0,
        );
        const scope = {
          interactionId: item.interactionId,
          generation: item.generation,
          threadId: item.threadId,
          turnId: item.turnId,
          exchangeId: sent.exchangeId,
        };
        const invalid =
          interaction === "approval"
            ? { decision: "accept" }
            : { answersJson: JSON.stringify({ wrong: { answers: ["yes"] } }) };
        const refused = await client.rpc("tools/call", {
          name: "gbot_codex_respond",
          arguments: { ...scope, ...invalid },
        });
        assert.equal(refused.result.isError, true);
        assert.equal(
          f.fake.received.filter((x) => x.id === "operator-1").length,
          0,
        );
        const valid =
          interaction === "approval"
            ? { decision: "decline" }
            : { answersJson: JSON.stringify({ choice: { answers: ["yes"] } }) };
        const accepted = await client.call("gbot_codex_respond", {
          ...scope,
          ...valid,
        });
        assert.equal(accepted.resolved, true);
        const again = await client.rpc("tools/call", {
          name: "gbot_codex_respond",
          arguments: { ...scope, ...valid },
        });
        assert.equal(again.result.isError, true);
        const response = f.fake.received.filter((x) => x.id === "operator-1");
        assert.equal(response.length, 1);
        assert.deepEqual(
          response[0].result,
          interaction === "approval"
            ? { decision: "decline" }
            : { answers: { choice: { answers: ["yes"] } } },
        );
      } finally {
        await client?.close();
        await f.close();
      }
    },
  );
test(
  "explicit CLI auto route preserves hop refusal before gateway submission",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const out = await cli(
        f.env,
        "send",
        "--reply-mode",
        "auto",
        "--codex-thread-id",
        "thread-chain",
        "--hop",
        "4",
        "--correlation-id",
        "chain",
        "General",
        "must not send",
      );
      assert.equal(out.code, 1, out.out + out.err);
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

for (const surface of ["MCP", "CLI"])
  for (const direction of ["grok", "codex"]) {
    test(
      `managed constraints: ${surface} ${direction} refuses a conflicting explicit Grok target`,
      { timeout: 20000 },
      async () => {
        const f = await fixture();
        let client;
        try {
          client = await mcp(
            resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
            f.env,
          );
          const { binding } = await client.call("gbot_bridge_start", {
            grokTarget: "General",
            codexThreadId: "thread-bound",
          });
          if (surface === "MCP") {
            const args =
              direction === "grok"
                ? {
                    target: "Alice",
                    bindingId: binding.id,
                    message: "must not reach General",
                  }
                : {
                    threadId: "thread-bound",
                    replyToGrok: "Alice",
                    bindingId: binding.id,
                    message: "must not return to General",
                  };
            const response = await client.rpc("tools/call", {
              name: direction === "grok" ? "gbot_send" : "codex_send",
              arguments: args,
            });
            assert.equal(
              response.result.isError,
              true,
              JSON.stringify(response),
            );
            assert.match(JSON.stringify(response), /Grok target.*binding/i);
          } else {
            const args =
              direction === "grok"
                ? [
                    "send",
                    "--binding-id",
                    binding.id,
                    "Alice",
                    "must not reach General",
                  ]
                : [
                    "codex",
                    "send",
                    "--binding-id",
                    binding.id,
                    "--reply-to-grok",
                    "Alice",
                    "thread-bound",
                    "must not return to General",
                  ];
            const response = await cli(f.env, ...args);
            assert.notEqual(response.code, 0, response.out + response.err);
            assert.match(response.out + response.err, /Grok target.*binding/i);
          }
          assert.equal(
            f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
            0,
          );
          assert.equal(
            f.fake.received.filter((x) =>
              ["turn/start", "turn/steer"].includes(x.method),
            ).length,
            0,
          );
        } finally {
          await client?.close();
          await f.close();
        }
      },
    );
  }

for (const surface of ["MCP", "CLI"])
  for (const option of ["expectedTurnId", "replyTo", "envelope"]) {
    test(
      `managed constraints: ${surface} codex refuses unsupported ${option} before submission`,
      { timeout: 30000 },
      async () => {
        const f = await fixture({ active: true });
        let client;
        try {
          client = await mcp(
            resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
            f.env,
          );
          const { binding } = await client.call("gbot_bridge_start", {
            grokTarget: "General",
            codexThreadId: "thread-active",
          });
          for (const route of [
            { replyToGrok: "General" },
            { bindingId: binding.id },
          ]) {
            const extra =
              option === "expectedTurnId"
                ? { whenBusy: "steer", expectedTurnId: "stale-turn" }
                : option === "replyTo"
                  ? { replyTo: "prior-message", correlationId: "chain" }
                  : { envelope: true };
            if (surface === "MCP") {
              const response = await client.rpc("tools/call", {
                name: "codex_send",
                arguments: {
                  threadId: "thread-active",
                  message: "do not submit",
                  ...route,
                  ...extra,
                },
              });
              assert.equal(
                response.result.isError,
                true,
                JSON.stringify(response),
              );
              assert.match(JSON.stringify(response), new RegExp(option));
            } else {
              const routeArgs = route.bindingId
                ? ["--binding-id", route.bindingId]
                : ["--reply-to-grok", "General"];
              const optionArgs =
                option === "expectedTurnId"
                  ? ["--when-busy", "steer", "--expected-turn-id", "stale-turn"]
                  : option === "replyTo"
                    ? [
                        "--reply-to",
                        "prior-message",
                        "--correlation-id",
                        "chain",
                      ]
                    : ["--envelope"];
              const response = await cli(
                f.env,
                "codex",
                "send",
                ...routeArgs,
                ...optionArgs,
                "thread-active",
                "do not submit",
              );
              assert.notEqual(response.code, 0, response.out + response.err);
              assert.match(response.out + response.err, new RegExp(option));
            }
          }
          assert.equal(
            f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
            0,
          );
          assert.equal(
            f.fake.received.filter((x) =>
              ["turn/start", "turn/steer"].includes(x.method),
            ).length,
            0,
          );
        } finally {
          await client?.close();
          await f.close();
        }
      },
    );
  }

test(
  "managed constraints: matching explicit Grok target and binding-only return remain supported",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      const { binding } = await client.call("gbot_bridge_start", {
        grokTarget: "General",
        codexThreadId: "thread-bound",
      });
      const matched = await client.call("gbot_send", {
        target: "General",
        bindingId: binding.id,
        message: "matching name",
      });
      assert.equal(matched.delivery, "accepted");
      const returned = await client.call("codex_send", {
        threadId: "thread-bound",
        replyToGrok: "bot-1",
        bindingId: binding.id,
        message: "matching ID",
      });
      assert.equal(returned.delivery, "accepted");
      const bindingOnly = await client.call("codex_send", {
        threadId: "thread-bound",
        bindingId: binding.id,
        message: "binding-only return",
      });
      assert.equal(bindingOnly.delivery, "accepted");
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        1,
      );
      assert.equal(
        f.fake.received.filter((x) => x.method === "turn/start").length,
        2,
      );
    } finally {
      await client?.close();
      await f.close();
    }
  },
);

test(
  "managed constraints: plain guarded sends retain legacy reply envelope options",
  { timeout: 20000 },
  async () => {
    const f = await fixture({ active: true });
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      const out = await client.call("codex_send", {
        threadId: "thread-active",
        message: "plain MCP",
        whenBusy: "steer",
        expectedTurnId: "turn-1",
        replyTo: "prior",
        correlationId: "plain-chain",
        envelope: true,
      });
      assert.equal(out.delivery, "accepted");
      const cliOut = await cli(
        f.env,
        "codex",
        "send",
        "--when-busy",
        "steer",
        "--expected-turn-id",
        "turn-1",
        "--reply-to",
        "prior",
        "--correlation-id",
        "plain-chain",
        "--envelope",
        "thread-active",
        "plain CLI",
      );
      assert.equal(cliOut.code, 0, cliOut.out + cliOut.err);
      const sends = f.fake.received.filter((x) => x.method === "turn/steer");
      assert.equal(sends.length, 2);
      for (const send of sends) {
        assert.equal(send.params.expectedTurnId, "turn-1");
        assert.match(JSON.stringify(send.params), /reply-to=prior/);
      }
    } finally {
      await client?.close();
      await f.close();
    }
  },
);

for (const surface of ["MCP", "CLI"])
  test(
    `per-send busy policy: ${surface} honors explicit and omitted policy without changing binding defaults`,
    { timeout: 30000 },
    async () => {
      const f = await fixture({ active: true });
      let client;
      try {
        client = await mcp(
          resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
          f.env,
        );
        for (const busyPolicy of ["steer", "reject"]) {
          const { binding } = await client.call("gbot_bridge_start", {
            grokTarget: busyPolicy === "steer" ? "General" : "Alice",
            codexThreadId: "thread-active",
            busyPolicy,
          });
          for (const whenBusy of ["reject", "steer", undefined]) {
            const before = f.fake.received.filter(
              (x) => x.method === "turn/steer",
            ).length;
            const out =
              surface === "MCP"
                ? await client.call("codex_send", {
                    threadId: "thread-active",
                    bindingId: binding.id,
                    message: "per-send policy",
                    ...(whenBusy === undefined ? {} : { whenBusy }),
                  })
                : JSON.parse(
                    (
                      await cli(
                        f.env,
                        "codex",
                        "send",
                        "--binding-id",
                        binding.id,
                        ...(whenBusy === undefined
                          ? []
                          : ["--when-busy", whenBusy]),
                        "thread-active",
                        "per-send policy",
                      )
                    ).out,
                  );
            const expected =
              (whenBusy ?? busyPolicy) === "reject" ? "rejected" : "accepted";
            assert.equal(
              out.delivery,
              expected,
              `${surface} binding=${busyPolicy} override=${whenBusy}`,
            );
            assert.equal(
              f.fake.received.filter((x) => x.method === "turn/steer").length -
                before,
              expected === "accepted" ? 1 : 0,
            );
            const status = await client.call("gbot_bridge_status", {
              bindingId: binding.id,
            });
            assert.equal(status.bindings[0].busyPolicy, busyPolicy);
          }
        }
      } finally {
        await client?.close();
        await f.close();
      }
    },
  );

test(
  "managed gateway cancellation: generated binding stop prevents held recipient preflight from sending",
  { timeout: 20000 },
  async () => {
    let armed = false,
      lookups = 0,
      entered,
      release;
    const reached = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const f = await fixture({
      onGateway: async (path) => {
        if (armed && path === "/api/listAgents" && ++lookups === 2) {
          entered();
          await gate;
        }
      },
    });
    let client;
    try {
      client = await mcp(
        resolve(process.env.RELAY_ARTIFACT_ROOT ?? "artifact"),
        f.env,
      );
      const { binding: a } = await client.call("gbot_bridge_start", {
        grokTarget: "General",
        codexThreadId: "thread-a",
      });
      const { binding: b } = await client.call("gbot_bridge_start", {
        grokTarget: "Alice",
        codexThreadId: "thread-b",
      });
      armed = true;
      const sending = client.call("gbot_send", {
        target: "General",
        bindingId: a.id,
        message: "cancel before prompt",
      });
      sending.catch(() => {});
      await reached;
      const status = await client.call("gbot_bridge_status", {
        bindingId: a.id,
      });
      assert.equal(status.receipts[0].delivery, "sending");
      await client.call("gbot_bridge_stop", { bindingId: a.id });
      const receipt = await sending;
      assert.equal(receipt.delivery, "rejected");
      assert.equal(receipt.reason, "cancelled");
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        0,
      );
      release();
      const other = await client.call("gbot_send", {
        target: "Alice",
        bindingId: b.id,
        message: "other binding",
      });
      assert.equal(other.delivery, "accepted");
      assert.equal(
        f.calls.filter((x) => x.path.endsWith("sendPrompt")).length,
        1,
      );
    } finally {
      release();
      await client?.close();
      await f.close();
    }
  },
);
