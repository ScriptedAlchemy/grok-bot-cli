import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));
const target = { id: "bot-1", name: "Researcher", description: "PRIVATE_INSTRUCTIONS" };
const group = { id: "group-1", name: "Launch", isGroup: true, memberIds: [target.id] };
const reply = "A long reply: " + "x".repeat(500) + "\nneedle at the end 🔧";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "gbot-history-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (/^(GROK_BOT_|CURSOR_|SAND_)/.test(key)) delete env[key];
  }
  env.GROK_BOT_TEST = "1";
  env.GROK_BOT_HISTORY = "on";
  env.GROK_BOT_ALLOW_LOCAL_GATEWAY = "1";
  const calls = [];
  const state = { failSend: false, payload: { entries: [
    { id: "reply-1", role: "assistant", preview: "A long reply: ...", content: [{ type: "text", text: reply }], createdAt: "2026-09-05T10:00:00Z", token: "PRIVATE_ENTRY_METADATA" },
  ], gatewayToken: "PRIVATE_RESPONSE_METADATA" } };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    calls.push({ method: req.url, body });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/listAgents") res.end(JSON.stringify({ agents: [target, group] }));
    else if (req.url === "/api/sendPrompt") {
      res.statusCode = state.failSend ? 500 : 200;
      res.end(JSON.stringify(state.failSend ? { error: "rejected" } : { ok: true, gatewayToken: "PRIVATE_SEND_METADATA" }));
    } else res.end(JSON.stringify(state.payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const onlineEnv = { ...env, GROK_BOT_GATEWAY_URL: "http://127.0.0.1:" + server.address().port, GROK_BOT_GATEWAY_TOKEN: "PRIVATE_AUTH" };
  const run = (args, extra = {}, online = true) => exec(process.execPath, [CLI, ...args], { env: { ...(online ? onlineEnv : env), ...extra } });
  const path = join(home, ".grok-bot-cli", "history.jsonl");
  const rows = () => readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
  return { home, path, rows, run, calls, state };
}

test("send persists a full multiline prompt across processes, searchable offline and with grep", async (t) => {
  const f = await fixture(t);
  const prompt = 'Investigate timeout\nwith "quotes" and Unicode 🔧';
  const sent = await f.run(["send", "Researcher", prompt, "--json"]);
  assert.equal(JSON.parse(sent.stdout).result.ok, true);
  assert.match(sent.stderr, /^(warning: GROK_BOT_ALLOW_LOCAL_GATEWAY is set; credentials may be sent to a loopback gateway\.\n)?$/);
  const [row] = f.rows();
  assert.equal(row.text, prompt);
  assert.equal(row.role, "user");
  assert.equal(row.event, "send");
  assert.deepEqual(row.target, { id: target.id, name: target.name, kind: "bot" });
  assert.ok(Number.isFinite(Date.parse(row.recordedAt)));
  assert.equal(readFileSync(f.path, "utf8").trim().split("\n").length, 1);
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /PRIVATE_/);
  const count = f.calls.length;
  const history = await f.run(["history", "researcher", "--search", "TIMEOUT", "--json"], {}, false);
  assert.deepEqual(JSON.parse(history.stdout), [row]);
  assert.equal(f.calls.length, count);
  const grep = await exec("grep", ["-n", "timeout", f.path]);
  assert.match(grep.stdout, /^1:/);
  if (process.platform !== "win32") {
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.home, ".grok-bot-cli")).mode & 0o777, 0o700);
  }
});

test("thread and chat preserve full replies, group and root metadata, and repeated observations", async (t) => {
  const f = await fixture(t);
  await f.run(["thread", "Researcher", "--limit", "80"]);
  assert.deepEqual(f.calls.at(-1), { method: "/api/getAgentTranscriptTail", body: { id: target.id, limit: 80 } });
  await f.run(["chat", "Launch", "--root", "root-1", "--json"]);
  assert.deepEqual(f.calls.at(-1), { method: "/api/getAgentThread", body: { id: group.id, rootId: "root-1" } });
  const rows = f.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, reply);
  assert.equal(rows[0].messageId, "reply-1");
  assert.equal(rows[0].timestamp, "2026-09-05T10:00:00Z");
  assert.equal(rows[1].rootId, "root-1");
  assert.equal(rows[1].target.kind, "group");
  assert.doesNotMatch(readFileSync(f.path, "utf8"), /PRIVATE_/);
  const found = await f.run(["history", "group-1", "--search", "needle", "--json"], {}, false);
  assert.deepEqual(JSON.parse(found.stdout), [rows[1]]);
  await f.run(["thread", "Researcher"]);
  assert.equal(f.rows().length, 3);
});

test("supports all transcript envelopes and text fields already displayed by the CLI", async (t) => {
  const f = await fixture(t);
  for (const [key, entry] of [
    ["messages", { messageId: "m1", sender: "assistant", message: "message text" }],
    ["items", { kind: "user", prompt: "prompt text" }],
    [null, { type: "assistant", content: "content text" }],
  ]) {
    f.state.payload = key ? { [key]: [entry] } : [entry];
    await f.run(["thread", "Researcher"]);
  }
  assert.deepEqual(f.rows().map((r) => r.text), ["message text", "prompt text", "content text"]);
});

test("thread --after returns exclusive deltas, no-op receipts, and bounded gap resets", async (t) => {
  const f = await fixture(t);
  const entries = Array.from({ length: 45 }, (_, index) => ({ id: `m${index + 1}`, text: `message ${index + 1}` }));
  f.state.payload = { entries };

  const newer = JSON.parse((await f.run(["thread", "Researcher", "--limit", "45", "--after", "m43", "--json"])).stdout);
  assert.deepEqual(f.calls.at(-1), { method: "/api/getAgentTranscriptTail", body: { id: target.id, limit: 45 } });
  assert.deepEqual(newer.transcript.entries, entries.slice(43));
  assert.deepEqual({ cursor: newer.cursor, entryCount: newer.entryCount, gapReset: newer.gapReset }, {
    cursor: "m45",
    entryCount: 2,
    gapReset: false,
  });

  const unchanged = JSON.parse((await f.run(["thread", "Researcher", "--limit", "45", "--after", "m45", "--json"])).stdout);
  assert.deepEqual(unchanged.transcript.entries, []);
  assert.deepEqual({ cursor: unchanged.cursor, entryCount: unchanged.entryCount, gapReset: unchanged.gapReset }, {
    cursor: "m45",
    entryCount: 0,
    gapReset: false,
  });

  const reset = JSON.parse((await f.run(["thread", "Researcher", "--limit", "40", "--after", "bogus", "--json"])).stdout);
  assert.deepEqual(reset.transcript.entries, entries.slice(-40));
  assert.deepEqual({ cursor: reset.cursor, entryCount: reset.entryCount, gapReset: reset.gapReset }, {
    cursor: "m45",
    entryCount: 40,
    gapReset: true,
  });
});

test("recording opt-outs do not create storage or disable access to existing history", async (t) => {
  const f = await fixture(t);
  await f.run(["send", "--no-history", "Researcher", "private prompt"]);
  for (const value of ["off", "FALSE", "0"]) {
    await f.run(["thread", "Researcher"], { GROK_BOT_HISTORY: value });
  }
  assert.equal(existsSync(f.path), false);
  await f.run(["send", "Researcher", "saved"]);
  await f.run(["thread", "--no-history", "Researcher"]);
  const found = await f.run(["history", "--json"], { GROK_BOT_HISTORY: "off" }, false);
  assert.equal(JSON.parse(found.stdout).length, 1);
  assert.equal(f.rows().length, 1);
});

test("history path is offline and side-effect free; flag directory overrides environment", async (t) => {
  const f = await fixture(t);
  const defaultPath = await f.run(["history", "--path"], {}, false);
  assert.equal(defaultPath.stdout.trim(), f.path);
  assert.equal(existsSync(f.path), false);
  const dir = join(f.home, "custom history");
  const extra = { GROK_BOT_HISTORY_DIR: join(f.home, "env-history") };
  await f.run(["send", "Researcher", "env"], extra);
  await f.run(["send", "--history-dir", dir, "Researcher", "flag"], extra);
  const found = await f.run(["history", "--history-dir", dir, "--json"], extra, false);
  assert.equal(JSON.parse(found.stdout)[0].text, "flag");
  const envHistory = await f.run(["history", "--json"], extra, false);
  assert.equal(JSON.parse(envHistory.stdout)[0].text, "env");
  const path = await f.run(["history", "--history-dir", dir, "--path", "--json"], extra, false);
  assert.deepEqual(JSON.parse(path.stdout), { path: join(dir, "history.jsonl") });
});

test("offline history handles missing files, filters before limiting, and validates options", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(["history"], {}, false)).stdout.trim(), "No local history.");
  assert.equal(existsSync(f.path), false);
  for (const text of ["match one", "match two", "unrelated"]) await f.run(["send", "Researcher", text]);
  const result = await f.run(["history", "--search", "match", "--limit", "1", "--json"], {}, false);
  assert.equal(JSON.parse(result.stdout)[0].text, "match two");
  assert.deepEqual(JSON.parse((await f.run(["history", "unknown", "--json"], {}, false)).stdout), []);
  for (const args of [["--limit", "0"], ["--limit", "1.5"], ["--limit", "NaN"], ["--path", "Researcher"], ["--unknown"]]) {
    await assert.rejects(f.run(["history", ...args], {}, false), (err) => err.code === 2);
  }
});

test("failed sends and empty threads leave no history; disk failure does not fail a successful send", async (t) => {
  const f = await fixture(t);
  f.state.failSend = true;
  await assert.rejects(f.run(["send", "Researcher", "rejected"]));
  const failed = await f.run(["send", "Researcher", "rejected", "--json"]).catch((err) => err);
  assert.equal(failed.code, 1);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.delivery, "unknown", "the request left; the gateway never acknowledged it");
  assert.match(failure.error, /sendPrompt failed: 500/);
  const sends = f.calls.filter((c) => c.method === "/api/sendPrompt").length;
  const looped = await f.run(["send", "--hop", "4", "Researcher", "ack", "--json"], {}, false).catch((err) => err);
  assert.equal(looped.code, 1);
  assert.equal(JSON.parse(looped.stdout).reason, "hop-limit");
  assert.equal(f.calls.filter((c) => c.method === "/api/sendPrompt").length, sends, "hop-limit refusals never reach the gateway");
  const usage = await f.run(["send", "--files", "--dir", f.home, "Researcher", "hi", "--json"], {}, false).catch((err) => err);
  assert.equal(usage.code, 1);
  assert.equal(JSON.parse(usage.stdout).reason, "usage", "StoreError keeps its name through redaction");
  assert.equal(existsSync(f.path), false);
  f.state.payload = { entries: [] };
  await f.run(["thread", "Researcher"]);
  assert.equal(existsSync(f.path), false);
  f.state.failSend = false;
  const blocked = join(f.home, "not-a-directory");
  writeFileSync(blocked, "occupied");
  const result = await f.run(["send", "--history-dir", blocked, "Researcher", "sent once", "--json"]);
  assert.equal(JSON.parse(result.stdout).result.ok, true);
  assert.match(result.stderr, /Warning: could not save local history/);
  assert.equal(f.calls.filter((c) => c.method === "/api/sendPrompt" && c.body.prompt === "sent once").length, 1);
  const protectedText = await f.run(["send", "Researcher", "--", "--json"]);
  assert.match(protectedText.stdout, /^Sent to bot Researcher/);
  assert.equal(f.calls.at(-1).body.prompt, "--json", "`--` makes flag-like text literal");
});

test("history skips malformed records and separates interrupted writes on the next append", async (t) => {
  const f = await fixture(t);
  await f.run(["send", "Researcher", "first"]);
  appendFileSync(f.path, 'null\n{"version":1}\n{"text":"interrupted');
  await f.run(["send", "Researcher", "second"]);
  const found = await f.run(["history", "--json"], {}, false);
  assert.deepEqual(JSON.parse(found.stdout).map((r) => r.text), ["first", "second"]);
  assert.match(found.stderr, /skipped 3 malformed/);
});

test("concurrent CLI processes append complete records", async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.run(["send", "Researcher", "parallel " + i])));
  assert.equal(f.rows().length, 8);
  assert.equal(new Set(f.rows().map((r) => r.text)).size, 8);
});

test("refuses to append through a history-file symlink", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const destination = join(f.home, "unrelated-file");
  writeFileSync(destination, "keep me");
  symlinkSync(destination, join(f.home, "history.jsonl"));
  const result = await f.run(["send", "--history-dir", f.home, "Researcher", "hello"]);
  assert.match(result.stderr, /could not save local history/);
  assert.equal(readFileSync(destination, "utf8"), "keep me");
});
