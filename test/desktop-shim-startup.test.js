import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renderWrapperScript, shouldBridge } from "../src/core/desktop-shim.js";

const canRunShellBridge = (() => {
  if (process.platform === "win32") return false;
  try {
    const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    return bash.status === 0 && python.status === 0;
  } catch {
    return false;
  }
})();

const CLIENT_INFO = JSON.stringify({
  name: "codex_desktop",
  title: "Codex Desktop",
  version: "26.1027.61615",
});

const STARTUP_CONFIG = JSON.stringify({
  appServerVersion: "0.166.0",
  configRequirements: { requirements: {} },
});

const ONE_SHOT_CASES = [
  {
    label: "startup config",
    argv: ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "--print-startup-config", "--startup-client-info", CLIENT_INFO],
    exit: 0,
    stdout: STARTUP_CONFIG,
  },
  {
    label: "startup config combined with sign-out",
    argv: [
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "--print-startup-config",
      "--startup-client-info",
      CLIENT_INFO,
      "--startup-sign-out",
    ],
    exit: 0,
    stdout: STARTUP_CONFIG,
  },
  {
    label: "startup config with equals-form client identity",
    argv: ["app-server", "--print-startup-config", `--startup-client-info=${CLIENT_INFO}`],
    exit: 0,
    stdout: STARTUP_CONFIG,
  },
  {
    label: "startup config child failure is not swallowed",
    argv: ["app-server", "--analytics-default-enabled", "--print-startup-config", "--startup-client-info", CLIENT_INFO],
    exit: 7,
    stdout: "",
    stderr: "real codex failed\n",
  },
  ...["--startup-sign-out", "--help", "-h", "--version", "-V"].map((flag) => ({
    label: flag,
    argv: ["app-server", flag],
    exit: 0,
    stdout: `real CLI ${flag}`,
  })),
  ...[["help", "app-server"], ["app-server", "help"]].map((argv) => ({
    label: argv.join(" "),
    argv,
    exit: 0,
    stdout: "real CLI help",
  })),
];

// Records argv, then emits exactly what the case asks for and exits with its
// code, so the wrapper's passthrough can be observed byte for byte.
const FAKE_REAL_SCRIPT = `#!/bin/bash
{
  for a in "$@"; do printf '%s\\n' "$a"; done
} > "$FAKE_REAL_ARGS"
printf '%s' "\${FAKE_REAL_STDOUT:-}"
printf '%s' "\${FAKE_REAL_STDERR:-}" >&2
exit "\${FAKE_REAL_EXIT:-0}"
`;

function writeExecutable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** Generated wrapper over a fake real CLI and a fake bridge that reports entry. */
function stageFixture(dir) {
  const realPath = join(dir, "real-codex");
  const bridgePath = join(dir, "codex-stdio-to-daemon-ws.py");
  const bridgeMarker = join(dir, "bridge-ran.txt");
  const wrapperPath = join(dir, "wrapper.sh");
  writeExecutable(realPath, FAKE_REAL_SCRIPT);
  writeExecutable(
    bridgePath,
    `#!/usr/bin/env python3
import pathlib
pathlib.Path(${JSON.stringify(bridgeMarker)}).write_text("yes")
print("BRIDGE-RAN")
`,
  );
  writeExecutable(
    wrapperPath,
    renderWrapperScript({
      bridgeLogPath: join(dir, "bridge.log"),
      bridgePath,
      codexHome: dir,
      realPath,
      wrapperLogPath: join(dir, "wrapper.log"),
    }),
  );
  return { bridgeMarker, wrapperPath };
}

/** Unix listener that only needs to accept the preflight connect and close. */
async function silentListener(socketPath) {
  rmSync(socketPath, { force: true });
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Desktop runs the one-shot child with ignored stdin and piped output. */
function runWrapper(wrapperPath, argv, env) {
  return spawnSync("bash", [wrapperPath, ...argv], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
}

function readRealArgs(path) {
  const text = readFileSync(path, "utf8");
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

function wrapperLog(dir) {
  const path = join(dir, "wrapper.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

test("generated wrapper forwards Desktop one-shot startup commands to the real CLI", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gbot-shim-startup-"));
  const daemon = await silentListener(join(root, "daemon.sock"));
  t.after(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const [index, tc] of ONE_SHOT_CASES.entries()) {
    await t.test(tc.label, () => {
      assert.equal(shouldBridge(tc.argv), false);
      const dir = join(root, `case-${index}`);
      mkdirSync(dir);
      const { bridgeMarker, wrapperPath } = stageFixture(dir);
      const argsPath = join(dir, "real-args.txt");
      const result = runWrapper(wrapperPath, tc.argv, {
        ...process.env,
        CODEX_APP_SERVER_SOCK: daemon.socketPath,
        CODEX_HOME: dir,
        FAKE_REAL_ARGS: argsPath,
        FAKE_REAL_EXIT: String(tc.exit),
        FAKE_REAL_STDERR: tc.stderr ?? "",
        FAKE_REAL_STDOUT: tc.stdout ?? "",
      });

      assert.ok(
        existsSync(argsPath),
        `real CLI was never invoked (status=${result.status}, stdout=${JSON.stringify(result.stdout)}); ` +
          `wrapper log: ${wrapperLog(dir)}`,
      );
      assert.deepEqual(readRealArgs(argsPath), tc.argv, "real CLI must receive Desktop's argv unchanged");
      assert.equal(result.stdout, tc.stdout ?? "");
      assert.equal(result.stderr, tc.stderr ?? "");
      assert.equal(result.status, tc.exit);
      assert.equal(existsSync(bridgeMarker), false, "one-shot command must not enter the interactive bridge");
    });
  }
});

test("generated wrapper still bridges ordinary interactive app-server sessions", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async (t) => {
  for (const argv of [
    ["app-server", "--analytics-default-enabled"],
    ["app-server", "--listen", "stdio://"],
    ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"],
  ]) {
    await t.test(argv.join(" "), async (t) => {
      assert.equal(shouldBridge(argv), true);
      const dir = mkdtempSync(join(tmpdir(), "gbot-shim-interactive-"));
      const daemon = await silentListener(join(dir, "daemon.sock"));
      t.after(async () => {
        await daemon.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const { bridgeMarker, wrapperPath } = stageFixture(dir);
      const argsPath = join(dir, "real-args.txt");

      const result = runWrapper(wrapperPath, argv, {
        ...process.env,
        CODEX_APP_SERVER_SOCK: daemon.socketPath,
        CODEX_HOME: dir,
        FAKE_REAL_ARGS: argsPath,
        FAKE_REAL_EXIT: "0",
        FAKE_REAL_STDERR: "",
        FAKE_REAL_STDOUT: "",
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /BRIDGE-RAN/);
      assert.ok(existsSync(bridgeMarker), "interactive app-server must still enter the bridge");
      assert.equal(existsSync(argsPath), false, "interactive app-server must not exec the real CLI when the daemon is reachable");
    });
  }
});
