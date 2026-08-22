import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("doctor reports a present but unusable Grok Bot app session", {
  skip: process.platform !== "darwin" && "Grok Bot app sessions are macOS-only",
}, () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-doctor-home-"));
  const descriptorPath = join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: {} }));
  const env = { ...process.env, HOME: home };
  for (const name of [
    "CURSOR_ACCESS_TOKEN",
    "GROK_BOT_ACCESS_TOKEN",
    "GROK_BOT_GATEWAY_URL",
    "GROK_BOT_GATEWAY_TOKEN",
    "SAND_ACCESS_TOKEN",
    "SAND_HOST_GATEWAY_URL",
    "SAND_HOST_GATEWAY_TOKEN",
    "SAND_GATEWAY_TOKEN",
  ]) delete env[name];

  const result = spawnSync(process.execPath, [CLI, "--json", "doctor"], {
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
