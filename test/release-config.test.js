import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

test("npm package metadata identifies the public source repository", () => {
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/ScriptedAlchemy/grok-bot-cli.git",
  });
  assert.equal(
    packageJson.homepage,
    "https://github.com/ScriptedAlchemy/grok-bot-cli#readme",
  );
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/ScriptedAlchemy/grok-bot-cli/issues",
  });
});

test("npm executable paths are already normalized for publishing", () => {
  assert.deepEqual(packageJson.bin, {
    gbot: "src/cli.js",
    "grok-bot": "src/cli.js",
    "gbot-install": "plugin/dist/bin/gbot-install.js",
  });
  // The plugin's npm root ships with the CLI and is built before any pack.
  assert.ok(packageJson.files.includes("plugin/dist"));
  assert.equal(packageJson.scripts.prepack, "npm run --silent build:plugin 1>&2");
});
