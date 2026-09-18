import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { inspect, readArtifactManifest } from "agent-bundle/api";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactRoot = fileURLToPath(new URL("../artifact/", import.meta.url));

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

test("committed artifact matches the complete source snapshot", async () => {
  const [source, artifact] = await Promise.all([
    inspect({ root: projectRoot }),
    readArtifactManifest(artifactRoot),
  ]);

  assert.equal(source.state, "ready");
  assert.equal(artifact.status, "ok");
  assert.deepEqual(
    artifact.manifest.compiler.project.sourceInputs,
    source.projectContext.sourceInputs,
  );
});
