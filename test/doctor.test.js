import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));

test("doctor reports a present but unusable Grok Bot app session", {
  skip: !["darwin", "linux"].includes(process.platform) && "Grok Bot app sessions are macOS/Linux-only",
}, () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-doctor-home-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, process.platform, {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: {} }));
  const env = { ...process.env, HOME: home };
  for (const name of [
    "XDG_CONFIG_HOME",
    "CURSOR_ACCESS_TOKEN",
    "GROK_BOT_GATEWAY_URL",
    "GROK_BOT_GATEWAY_TOKEN",
  ]) delete env[name];

  const result = spawnSync(process.execPath, [CLI, "doctor", "--json"], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.grokBotAppSession, {
    present: true,
    usable: false,
    code: "EMPTY_ENTRIES",
    error: "Grok Bot gateway descriptor has no saved gateway entries.",
  });
});
