import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const artifactManifest = readJson("../artifact/agent-bundle.manifest.json");

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

test("repository marketplaces install the committed artifact", () => {
  const claude = readJson("../.claude-plugin/marketplace.json");
  const codex = readJson("../.agents/plugins/marketplace.json");
  const cursor = readJson("../.cursor-plugin/marketplace.json");

  assert.equal(claude.plugins[0].source, "./artifact");
  assert.deepEqual(codex.plugins[0].source, {
    path: "./artifact",
    source: "local",
  });
  assert.equal(cursor.plugins[0].source, "./artifact");
});

test("committed artifact matches every recorded source input", () => {
  for (const input of artifactManifest.compiler.project.sourceInputs) {
    const source = new URL(`../${input.path}`, import.meta.url);
    assert.equal(
      createHash("sha256").update(readFileSync(source)).digest("hex"),
      input.sha256,
      input.path,
    );
    assert.equal(Boolean(statSync(source).mode & 0o111), input.executable, input.path);
  }
});
