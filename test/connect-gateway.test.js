import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/app-session.js";
import { connectGateway } from "../src/gateway.js";

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const v = values[key];
    if (v == null) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function writeBrokenAppSession() {
  const home = mkdtempSync(join(tmpdir(), "gbot-connect-home-"));
  const env =
    process.platform === "linux"
      ? { XDG_CONFIG_HOME: join(home, ".config") }
      : process.platform === "win32"
        ? { APPDATA: join(home, "AppData/Roaming") }
        : {};
  const descriptorPath = grokBotGatewayDescriptorPath(home, process.platform, {
    ...process.env,
    ...env,
    HOME: home,
  });
  mkdirSync(dirname(descriptorPath), { recursive: true });
  // Present but unusable — empty v2 entries (and no Local State on Windows).
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: {} }));
  return { home, env };
}

test("unusable app session falls through to CURSOR_ACCESS_TOKEN EnsureSandBox", async (t) => {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    t.skip("app session platforms only");
    return;
  }

  const { home, env } = writeBrokenAppSession();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    return new Response(
      JSON.stringify({
        gatewayUrl: "https://box.cursor.sh",
        gatewayToken: "from-ensure",
      }),
      { status: 200 },
    );
  });

  await withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      CURSOR_ACCESS_TOKEN: "cursor-access-token",
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      SAND_HOST_GATEWAY_URL: null,
      SAND_HOST_GATEWAY_TOKEN: null,
      SAND_GATEWAY_TOKEN: null,
      GROK_BOT_ACCESS_TOKEN: null,
      SAND_ACCESS_TOKEN: null,
      GROK_BOT_ALLOW_ANY_GATEWAY: null,
      GROK_BOT_ALLOW_LOCAL_GATEWAY: null,
      ...env,
    },
    async () => {
      const session = await connectGateway();
      assert.equal(session.gatewayUrl, "https://box.cursor.sh");
      assert.equal(session.gatewayToken, "from-ensure");
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /EnsureSandBox/);
    },
  );
});

test("unusable app session without access token surfaces the session error", async (t) => {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    t.skip("app session platforms only");
    return;
  }

  const { home, env } = writeBrokenAppSession();
  await withEnv(
    {
      HOME: home,
      USERPROFILE: home,
      CURSOR_ACCESS_TOKEN: null,
      GROK_BOT_ACCESS_TOKEN: null,
      SAND_ACCESS_TOKEN: null,
      GROK_BOT_GATEWAY_URL: null,
      GROK_BOT_GATEWAY_TOKEN: null,
      SAND_HOST_GATEWAY_URL: null,
      SAND_HOST_GATEWAY_TOKEN: null,
      SAND_GATEWAY_TOKEN: null,
      ...env,
    },
    async () => {
      await assert.rejects(
        connectGateway(),
        (error) => {
          assert.equal(error.name, "GatewayError");
          assert.match(error.message, /no saved gateway entries/i);
          return true;
        },
      );
    },
  );
});
