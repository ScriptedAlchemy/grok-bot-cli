import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Enumerate test/*.test.js in JS so Windows cmd and Node 18/24 all work
// (shell globs do not expand on Windows; `node --test test` is not a directory walk).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "test");
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status === null ? 1 : result.status);
