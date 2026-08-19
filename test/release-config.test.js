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
