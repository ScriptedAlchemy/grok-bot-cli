import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
for (const inherited of ["0", ""]) {
  test(`unit bootstrap overrides inherited GROK_BOT_TEST=${JSON.stringify(inherited)} before loading tests`, () => {
    const fixture = mkdtempSync(join(tmpdir(), "gbot-test-bootstrap-"));
    try {
      mkdirSync(join(fixture, "test"));
      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", scripts: { "test:unit": config.scripts["test:unit"] } }));
      for (const path of ["scripts", "test.env"]) {
        if (existsSync(new URL(path, root))) cpSync(new URL(path, root), join(fixture, path), { recursive: true });
      }
      writeFileSync(join(fixture, "test", "guard.test.js"), `
import assert from "node:assert/strict";
import { assertAllowedCredentialUrl } from ${JSON.stringify(new URL("src/core/url-policy.js", root).href)};
globalThis.fetch = () => { throw new Error("No network allowed in bootstrap regression"); };
assert.throws(() => assertAllowedCredentialUrl("https://api2.cursor.sh", { kind: "backend" }), /test mode.*loopback/);
assert.equal(process.env.GROK_BOT_TEST, "1");
console.log("bootstrap-policy-verified");
`);
      const childEnv = { ...process.env, GROK_BOT_TEST: inherited, NODE_ENV: "production" };
      delete childEnv.NODE_TEST_CONTEXT;
      const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "test:unit"], {
        cwd: fixture,
        env: childEnv,
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /bootstrap-policy-verified/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
