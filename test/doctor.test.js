import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { grokBotGatewayDescriptorPath } from "../src/core/app-session.js";

const CLI = fileURLToPath(new URL("../dist/bin/gbot.mjs", import.meta.url));

for (const version of [2, 3]) {
  test(`doctor reports an unusable version ${version} app session`, {
    skip: !["darwin", "linux", "win32"].includes(process.platform) && "Unsupported app-session platform",
  }, () => {
    const fixtureHome = mkdtempSync(join(tmpdir(), "gbot-doctor-home-"));
    const env = {
      ...process.env,
      HOME: fixtureHome,
      USERPROFILE: fixtureHome,
      APPDATA: join(fixtureHome, "AppData/Roaming"),
    };
    for (const name of [
      "XDG_CONFIG_HOME",
      "CURSOR_ACCESS_TOKEN",
      "GROK_BOT_GATEWAY_URL",
      "GROK_BOT_GATEWAY_TOKEN",
    ]) delete env[name];
    const descriptorPath = grokBotGatewayDescriptorPath(fixtureHome, process.platform, env);
    mkdirSync(dirname(descriptorPath), { recursive: true });
    writeFileSync(descriptorPath, JSON.stringify({ version, entries: {} }));

    const result = spawnSync(process.execPath, [CLI, "doctor", "--json"], {
      encoding: "utf8",
      env,
      timeout: 20_000,
      windowsHide: true,
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
}
