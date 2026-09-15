import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BRIDGE_SOURCE } from "../src/core/desktop-shim-bridge.js";
import {
  defaultPaths,
  desktopShimStatus,
  installDesktopShim,
  renderEnvScript,
  renderPlist,
  renderWrapperScript,
  SHIM_LABEL,
  shouldBridge,
  uninstallDesktopShim,
} from "../src/core/desktop-shim.js";

test("shouldBridge only rewrites bare app-server spawns", () => {
  assert.equal(shouldBridge(["app-server"]), true);
  assert.equal(shouldBridge(["-c", "x", "app-server"]), true);
  assert.equal(shouldBridge([]), false);
  assert.equal(shouldBridge(["--version"]), false);
  assert.equal(shouldBridge(["app-server", "daemon", "start"]), false);
  assert.equal(shouldBridge(["app-server", "proxy"]), false);
  assert.equal(shouldBridge(["app-server", "generate-json-schema"]), false);
  assert.equal(shouldBridge(["app-server", "generate-ts"]), false);
});

test("default paths live under the Codex home, never the package checkout", () => {
  const paths = defaultPaths({ env: { CODEX_HOME: "/tmp/shim-home", HOME: "/tmp/shim-user" }, home: "/tmp/shim-user" });
  assert.equal(paths.codexHome, "/tmp/shim-home");
  assert.equal(paths.wrapperPath, join("/tmp/shim-home", "bin", "codex-desktop-to-daemon"));
  assert.equal(paths.bridgePath, join("/tmp/shim-home", "bin", "codex-stdio-to-daemon-ws.py"));

  const fallback = defaultPaths({ env: { HOME: "/tmp/shim-user" }, home: "/tmp/shim-user" });
  assert.equal(fallback.codexHome, join("/tmp/shim-user", ".codex"));
  assert.ok(fallback.wrapperPath.startsWith(join("/tmp/shim-user", ".codex", "bin")));
});

test("wrapper fails open and never scrapes private Desktop channels", () => {
  const script = renderWrapperScript({
    bridgeLogPath: "/b/bridge.log",
    bridgePath: "/b/bridge.py",
    wrapperLogPath: "/b/w.log",
    realPath: "/r/codex",
    socketPath: "/b/app-server-control.sock",
  });
  assert.match(script, /command -v python3/);
  assert.match(script, /exec "\$REAL" "\$@"/);
  assert.match(script, /bridge unavailable, passthrough/);
  assert.doesNotMatch(script, /codex-browser-use/);
  assert.doesNotMatch(script, /CODEX_APP_TOOLS_PIPE_PATH/);
  assert.doesNotMatch(script, /app-server proxy/);
  // Env overrides survive so operators can relocate the install.
  assert.match(script, /CODEX_DESKTOP_BRIDGE/);
  assert.match(script, /CODEX_DESKTOP_WRAPPER_REAL/);
});

test("wrapper preflights the socket and runs the bridge as a fallible child", () => {
  const script = renderWrapperScript({
    bridgeLogPath: "/b/bridge.log",
    bridgePath: "/b/bridge.py",
    wrapperLogPath: "/b/w.log",
    realPath: "/r/codex",
    socketPath: "/b/app-server-control.sock",
  });
  // No `exec python3`: exec would replace the wrapper before connect, so a
  // failed connect could never reach the fallback.
  assert.doesNotMatch(script, /exec python3/);
  assert.match(script, /preflight\(\)/);
  assert.match(script, /CODEX_DESKTOP_PREFLIGHT_TIMEOUT/);
  assert.match(script, /python3 "\$BRIDGE"\n\s+rc=\$\?/);
  assert.match(script, /bridge exited \$rc, falling through to real codex/);
});

test("wrapper exports the configured socket so CODEX_HOME is honored", () => {
  const custom = defaultPaths({ env: { CODEX_HOME: "/tmp/custom-home", HOME: "/tmp/u" }, home: "/tmp/u" });
  const script = renderWrapperScript(custom);
  assert.ok(custom.socketPath.startsWith("/tmp/custom-home"));
  assert.match(script, /export CODEX_APP_SERVER_SOCK="\$SOCK"/);
  assert.ok(script.includes(`SOCK="\${CODEX_APP_SERVER_SOCK:-${custom.socketPath}}"`));
  assert.ok(script.includes(`BRIDGE_LOG="\${CODEX_STDIO_BRIDGE_LOG:-${custom.bridgeLogPath}}"`));

  const fallback = defaultPaths({ env: { HOME: "/tmp/u" }, home: "/tmp/u" });
  const fallbackScript = renderWrapperScript(fallback);
  assert.ok(
    fallbackScript.includes(`SOCK="\${CODEX_APP_SERVER_SOCK:-${join("/tmp/u", ".codex", "app-server-control", "app-server-control.sock")}}"`),
  );
});

test("vendored bridge bounds the connect/handshake and closes on failure", () => {
  assert.match(BRIDGE_SOURCE, /CODEX_BRIDGE_CONNECT_TIMEOUT/);
  assert.match(BRIDGE_SOURCE, /s\.settimeout\(timeout\)/);
  assert.match(BRIDGE_SOURCE, /s\.settimeout\(None\)/);
});

test("vendored bridge is the proven stdio-ws bridge, verbatim", () => {
  assert.ok(BRIDGE_SOURCE.startsWith("#!/usr/bin/env python3"));
  assert.match(BRIDGE_SOURCE, /app-server-control\.sock/);
  assert.doesNotMatch(BRIDGE_SOURCE, /codex-browser-use/);
  assert.doesNotMatch(BRIDGE_SOURCE, /CODEX_APP_TOOLS_PIPE_PATH/);
});

test("env script and plist point at the installed paths with the stable label", () => {
  const renderedEnv = renderEnvScript({ wrapperPath: "/w", realPath: "/r", envLogPath: "/l" });
  assert.match(renderedEnv, /launchctl setenv CODEX_CLI_PATH/);
  assert.match(renderedEnv, /WRAPPER="\/w"/);
  assert.doesNotMatch(renderedEnv, /Users\/zackjackson/);

  const plist = renderPlist({ envScriptPath: "/w/env.sh" });
  assert.match(plist, new RegExp(SHIM_LABEL.replace(/\./g, "\\.")));
  assert.match(plist, /\/w\/env\.sh/);
  assert.match(plist, /<string>Aqua<\/string>/);
});

test("install then uninstall round-trips in a scratch Codex home (no live Desktop)", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-shim-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "gbot-shim-codex-"));
  const env = { CODEX_HOME: codexHome, HOME: home };
  const calls = [];
  const runner = (file, args) => {
    calls.push([file, ...args].join(" "));
    return { status: 0 };
  };

  const before = desktopShimStatus({ env, home, platform: "linux" });
  assert.equal(before.installed, false);
  assert.equal(before.exitCode, 1);

  const installed = installDesktopShim({ env, home, platform: "linux", runner });
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.persisted, false);
  assert.ok(installed.warnings.some((w) => /macOS-only/.test(String(w))));
  // ~/.codex/bin holds scripts only: no .md/.txt revert notes to clean up.
  assert.deepEqual(
    readdirSync(installed.wrapperPath.replace(/\/codex-desktop-to-daemon$/, "")).sort(),
    ["codex-desktop-shared-daemon-env.sh", "codex-desktop-to-daemon", "codex-stdio-to-daemon-ws.py"],
  );

  const after = desktopShimStatus({ env: { ...env, CODEX_CLI_PATH: installed.wrapperPath }, home, platform: "linux" });
  assert.equal(after.installed, true);
  assert.equal(after.exitCode, 0);
  assert.equal(after.wrapperExecutable, true);
  assert.equal(after.wrapperPointsAtShim, true);

  const uninstalled = uninstallDesktopShim({ env, home, platform: "linux", runner });
  assert.equal(uninstalled.exitCode, 0);
  const gone = desktopShimStatus({ env, home, platform: "linux" });
  assert.equal(gone.installed, false);
});

test("darwin install writes the LaunchAgent and drives it through the runner", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-shim-mac-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "gbot-shim-mac-codex-"));
  const env = { CODEX_HOME: codexHome, HOME: home };
  const calls = [];
  const runner = (file, args) => {
    calls.push([file, ...args].join(" "));
    return { status: 0 };
  };
  const installed = installDesktopShim({ env, home, platform: "darwin", runner });
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.persisted, true);
  assert.ok(installed.plistPath.endsWith(`${SHIM_LABEL}.plist`));
  assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")));
  assert.ok(calls.some((c) => c.includes("setenv CODEX_CLI_PATH")));
});

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

/** Render a runnable wrapper wired to a fake real codex in dir. */
function stageWrapper(dir, { bridgePath, socketPath }) {
  const realPath = join(dir, "real-codex");
  writeFileSync(realPath, '#!/bin/bash\necho "FAKE-REAL argv: $*"\n');
  chmodSync(realPath, 0o755);
  const wrapperPath = join(dir, "wrapper.sh");
  const script = renderWrapperScript({
    bridgeLogPath: join(dir, "bridge.log"),
    bridgePath,
    wrapperLogPath: join(dir, "wrapper.log"),
    realPath,
    socketPath,
  });
  writeFileSync(wrapperPath, script);
  chmodSync(wrapperPath, 0o755);
  return { realPath, wrapperPath };
}

const runWrapper = (wrapperPath, args, env) =>
  spawnSync("bash", [wrapperPath, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60000 });

/** Unix listener that accepts connections and never answers (wedged daemon). */
async function silentListener(socketPath) {
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  const server = createServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

test("wrapper falls through to real codex when the socket is absent", {
  skip: !canRunShellBridge && "needs bash + python3",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-absent-"));
  const bridgePath = join(dir, "bridge.py");
  writeFileSync(bridgePath, '#!/usr/bin/env python3\nimport sys; sys.exit(0)\n');
  const { wrapperPath } = stageWrapper(dir, { bridgePath, socketPath: join(dir, "no-such.sock") });
  const out = runWrapper(wrapperPath, ["app-server"], {});
  assert.equal(out.status, 0);
  assert.match(out.stdout, /FAKE-REAL argv: app-server/);
});

test("wrapper falls through to real codex when the handshake times out", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-hang-"));
  const socketPath = join(dir, "wedged.sock");
  const server = await silentListener(socketPath);
  try {
    const bridgePath = join(dir, "codex-stdio-to-daemon-ws.py");
    writeFileSync(bridgePath, BRIDGE_SOURCE);
    const { wrapperPath } = stageWrapper(dir, { bridgePath, socketPath });
    const started = Date.now();
    const out = runWrapper(wrapperPath, ["app-server"], { CODEX_BRIDGE_CONNECT_TIMEOUT: "1" });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 0);
    assert.match(out.stdout, /FAKE-REAL argv: app-server/);
    assert.ok(elapsed < 30000, `fail-open must be bounded, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("wrapper exits 0 without touching real codex when the bridge serves", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-ok-"));
  const socketPath = join(dir, "fine.sock");
  const server = await silentListener(socketPath);
  try {
    const bridgePath = join(dir, "bridge-ok.py");
    writeFileSync(bridgePath, '#!/usr/bin/env python3\nimport sys; sys.exit(0)\n');
    const { wrapperPath } = stageWrapper(dir, { bridgePath, socketPath });
    const out = runWrapper(wrapperPath, ["app-server"], {});
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /FAKE-REAL/);
  } finally {
    server.close();
  }
});

test("bridge handshake timeout fails fast against a silent listener", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-ws-"));
  const socketPath = join(dir, "silent.sock");
  const server = await silentListener(socketPath);
  try {
    const bridgePath = join(dir, "codex-stdio-to-daemon-ws.py");
    writeFileSync(bridgePath, BRIDGE_SOURCE);
    const started = Date.now();
    const out = spawnSync("python3", [bridgePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_APP_SERVER_SOCK: socketPath,
        CODEX_BRIDGE_CONNECT_TIMEOUT: "1",
        CODEX_STDIO_BRIDGE_LOG: join(dir, "bridge.log"),
      },
      input: "",
      timeout: 30000,
    });
    const elapsed = Date.now() - started;
    assert.notEqual(out.status, 0);
    assert.ok(elapsed < 20000, `handshake must time out instead of hanging, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test("status reads the GUI-domain CODEX_CLI_PATH on darwin", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-shim-gui-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "gbot-shim-gui-codex-"));
  const env = { CODEX_HOME: codexHome, HOME: home };
  const noRunner = () => ({ status: 0, stdout: "" });
  installDesktopShim({ env, home, platform: "darwin", runner: noRunner });
  const paths = defaultPaths({ env, home });

  // Shell env is stale, but the GUI domain points at the shim: Desktop-facing state wins.
  const guiRunner = (file, args) => {
    assert.equal(file, "launchctl");
    assert.deepEqual(args, ["getenv", "CODEX_CLI_PATH"]);
    return { status: 0, stdout: `${paths.wrapperPath}\n` };
  };
  const active = desktopShimStatus({ env, home, platform: "darwin", runner: guiRunner });
  assert.equal(active.guiCliPath, paths.wrapperPath);
  assert.equal(active.cliPath, null);
  assert.equal(active.desktopCliPath, paths.wrapperPath);
  assert.equal(active.wrapperPointsAtShim, true);

  // launchctl failure degrades to unknown instead of misreporting.
  const failing = desktopShimStatus({
    env,
    home,
    platform: "darwin",
    runner: () => ({ error: new Error("no launchd"), status: null }),
  });
  assert.equal(failing.guiCliPath, null);
  assert.equal(failing.wrapperPointsAtShim, false);
  assert.ok(failing.warnings.length > 0);
});
