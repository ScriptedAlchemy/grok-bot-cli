import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { grokBotAppVersion, loadGrokBotAppCredentials } from "../src/core/app-session.js";
import { connectGateway, createAgent, listAgents, sendPrompt } from "../src/core/gateway.js";

function encrypt(value) {
  const key = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]).toString("base64");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gbot-reconnect-"));
  const dir = join(root, "Grok Bot");
  mkdirSync(dir);
  const descriptor = join(dir, "gateway-descriptor.json");
  writeFileSync(descriptor, JSON.stringify({
    version: 3,
    entries: { only: { encrypted: encrypt(JSON.stringify({
      baseUrl: "http://127.0.0.1:1341",
      token: "old-gateway",
      headers: { "x-anyrun-network-token": "old-route" },
    })) } },
  }));
  const store = {
    active: "first",
    accounts: {
      first: { "cursor-access-token": encrypt("fake-access"), "cursor-selected-team-id": encrypt("12") },
      other: { "cursor-access-token": encrypt("other-access") },
    },
  };
  const save = () => writeFileSync(join(dir, "sand-secrets.json"), JSON.stringify({
    version: 1, "cursor-accounts": JSON.stringify(store),
  }));
  save();
  writeFileSync(join(dir, "desktop-status.json"), JSON.stringify({ appVersion: "0.71.2" }));
  const values = {
    GROK_BOT_TEST: "1", CURSOR_API_BASE_URL: "http://127.0.0.1:1340",
    GROK_BOT_GATEWAY_URL: null, GROK_BOT_GATEWAY_TOKEN: null,
    GROK_BOT_GATEWAY_HEADERS: null, CURSOR_ACCESS_TOKEN: null,
    SAND_CLIENT_VERSION: "0.71.2",
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    if (value === null) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const appSessionOptions = { home: root, platform: "linux", env: { XDG_CONFIG_HOME: root } };
  return { root, dir, descriptor, store, save, appSessionOptions };
}

function sleeping(headers = {}) {
  return new Response("", { status: 417, headers: {
    "x-anyrun-error-source": "anyrun-proxy",
    "x-anyrun-failure-reason": "pod_hibernated",
    ...headers,
  } });
}

function fresh() {
  return Response.json({
    gatewayUrl: "http://127.0.0.1:1342", gatewayToken: "new-gateway",
    gatewayHeaders: { "X-Anyrun-Network-Token": "new-route" },
  });
}

const roster = { agents: [{ id: "one", name: "Research" }] };

test("hibernated read refreshes active credentials, team and routing headers without rewriting app data", async (t) => {
  const f = fixture(t);
  const original = readFileSync(f.descriptor, "utf8");
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/EnsureSandBox")) {
      assert.equal(options.headers.authorization, "Bearer fake-access");
      assert.equal(options.headers["x-cursor-team-id"], "12");
      assert.equal(options.headers["x-cursor-client-version"], "0.71.2");
      assert.equal(options.redirect, "error");
      return fresh();
    }
    if (url.startsWith("http://127.0.0.1:1341/")) return sleeping();
    assert.equal(options.headers.authorization, "Bearer new-gateway");
    assert.equal(options.headers["x-anyrun-network-token"], "new-route");
    assert.equal(options.body, "{}");
    return Response.json(roster);
  });
  const session = await connectGateway(f);
  assert.equal((await listAgents(session)).length, 1);
  assert.equal(session.gatewayToken, "new-gateway");
  await listAgents(session);
  assert.equal(calls.filter(c => c.url.endsWith("/EnsureSandBox")).length, 1);
  assert.equal(readFileSync(f.descriptor, "utf8"), original);
});

test("a second hibernation response ends the read instead of looping", async (t) => {
  const f = fixture(t);
  let ensures = 0, reads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/EnsureSandBox")) { ensures++; return fresh(); }
    reads++;
    return sleeping();
  });
  await assert.rejects(listAgents(await connectGateway(f)), { status: 417 });
  assert.equal(ensures, 1);
  assert.equal(reads, 2);
});

test("concurrent hibernated reads share one refresh", async (t) => {
  const f = fixture(t);
  let ensures = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/EnsureSandBox")) {
      ensures++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return fresh();
    }
    return url.startsWith("http://127.0.0.1:1341/") ? sleeping() : Response.json(roster);
  });
  const session = await connectGateway(f);
  const results = await Promise.all([listAgents(session), listAgents(session)]);
  assert.equal(results.length, 2);
  assert.equal(ensures, 1);
});

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} never starts a reconnect`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("", { status }); });
    await assert.rejects(listAgents(await connectGateway(f)), { status });
    assert.equal(calls, 1);
  });
}

test("generic 417 and transport errors do not reconnect", async (t) => {
  const f = fixture(t);
  const session = await connectGateway(f);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("", { status: 417 }); });
  await assert.rejects(listAgents(session), { status: 417 });
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("fetch failed"); });
  await assert.rejects(listAgents(session), /fetch failed/);
  assert.equal(calls, 2);
});

test("explicit gateway overrides do not switch to desktop credentials", async (t) => {
  const f = fixture(t);
  process.env.GROK_BOT_GATEWAY_URL = "http://127.0.0.1:1343";
  process.env.GROK_BOT_GATEWAY_TOKEN = "explicit";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return sleeping(); });
  await assert.rejects(listAgents(await connectGateway(f)), { status: 417 });
  assert.equal(calls, 1);
});

test("active account drift is rejected before EnsureSandBox", async (t) => {
  const f = fixture(t);
  const session = await connectGateway(f);
  f.store.active = "other";
  f.save();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return sleeping(); });
  await assert.rejects(listAgents(session), { code: "ACCOUNT_CHANGED" });
  assert.equal(calls, 1);
});

test("active account drift during reconnect discards the new route", async (t) => {
  const f = fixture(t);
  const session = await connectGateway(f);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/EnsureSandBox")) {
      f.store.active = "other";
      f.save();
      return fresh();
    }
    return sleeping();
  });
  await assert.rejects(listAgents(session), /active account changed during reconnect/);
  assert.equal(session.gatewayToken, "old-gateway");
});

test("refreshed destinations remain subject to credential-host policy", async (t) => {
  const f = fixture(t);
  const session = await connectGateway(f);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    if (url.endsWith("/EnsureSandBox")) return Response.json({ gatewayUrl: "https://untrusted.invalid", gatewayToken: "new" });
    return sleeping();
  });
  await assert.rejects(listAgents(session), /Rejected gateway URL/);
  assert.equal(calls, 2);
  assert.equal(session.gatewayToken, "old-gateway");
});

test("failed refresh is bounded and redacts named credentials", async (t) => {
  const f = fixture(t);
  let ensures = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/EnsureSandBox")) {
      ensures++;
      return Response.json({ message: "accessToken=must-not-appear" }, { status: 401 });
    }
    return sleeping();
  });
  await assert.rejects(listAgents(await connectGateway(f)), error => {
    assert.equal(error.status, 401);
    assert.equal(error.message.includes("must-not-appear"), false);
    return true;
  });
  assert.equal(ensures, 1);
});

for (const operation of ["sendPrompt", "createAgent"]) {
  test(`${operation} is never replayed after hibernation`, async (t) => {
    const f = fixture(t);
    let writes = 0, ensures = 0;
    t.mock.method(globalThis, "fetch", async (url) => {
      if (url.endsWith("/EnsureSandBox")) { ensures++; return fresh(); }
      if (url.endsWith("/listAgents")) return Response.json(roster);
      writes++;
      return sleeping();
    });
    const session = await connectGateway(f);
    const work = operation === "sendPrompt"
      ? sendPrompt(session, "Research", "synthetic test only")
      : createAgent(session, { name: "synthetic test only" });
    await assert.rejects(work, { status: 417 });
    assert.equal(writes, 1);
    assert.equal(ensures, 0);
  });
}

test("aborted reads do not reconnect", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { controller.abort(); return sleeping(); });
  await assert.rejects(listAgents(await connectGateway(f), { signal: controller.signal }), /cancelled/);
});

test("app version is validated and account selection never falls back to another account", (t) => {
  const f = fixture(t);
  assert.equal(grokBotAppVersion(f.appSessionOptions), "0.71.2");
  writeFileSync(join(f.dir, "desktop-status.json"), JSON.stringify({ appVersion: "invalid\r\nheader" }));
  assert.equal(grokBotAppVersion(f.appSessionOptions), null);
  f.store.active = "missing";
  f.save();
  assert.equal(loadGrokBotAppCredentials(f.appSessionOptions), null);
});

test("invalid team and tampered active credentials fail closed", (t) => {
  const f = fixture(t);
  f.store.accounts.first["cursor-selected-team-id"] = encrypt("not-a-team");
  f.save();
  assert.throws(() => loadGrokBotAppCredentials(f.appSessionOptions), { code: "INVALID_TEAM" });
  f.store.accounts.first["cursor-access-token"] = "invalid";
  f.save();
  assert.throws(() => loadGrokBotAppCredentials(f.appSessionOptions));
});

test("Windows active credentials use DPAPI and AES-GCM without selecting another account", (t) => {
  const f = fixture(t);
  const key = Buffer.alloc(32, 7);
  const windowsEncrypt = (text) => {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    return Buffer.concat([Buffer.from("v10"), nonce, cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString("base64");
  };
  f.store.accounts.first["cursor-access-token"] = windowsEncrypt("windows-fake");
  f.store.accounts.first["cursor-selected-team-id"] = windowsEncrypt("42");
  f.save();
  writeFileSync(join(f.dir, "Local State"), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.from("DPAPIfake-key").toString("base64") },
  }));
  const credentials = loadGrokBotAppCredentials({
    platform: "win32", appData: f.root, expectedAccountKey: "first",
    unprotectData: blob => { assert.equal(blob.toString(), "fake-key"); return key; },
  });
  assert.deepEqual(credentials, { accessToken: "windows-fake", accountKey: "first", teamId: "42" });
  assert.throws(() => loadGrokBotAppCredentials({
    platform: "win32", appData: f.root, expectedAccountKey: "other",
    unprotectData: () => { throw new Error("must reject account before DPAPI"); },
  }), { code: "ACCOUNT_CHANGED" });
});
