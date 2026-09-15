import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
  const script = renderWrapperScript({ realPath: "/r/codex", bridgePath: "/b/bridge.py", logPath: "/b/w.log" });
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

test("vendored bridge is the proven stdio-ws bridge, verbatim", () => {
  assert.ok(BRIDGE_SOURCE.startsWith("#!/usr/bin/env python3"));
  assert.match(BRIDGE_SOURCE, /app-server-control\.sock/);
  assert.doesNotMatch(BRIDGE_SOURCE, /codex-browser-use/);
  assert.doesNotMatch(BRIDGE_SOURCE, /CODEX_APP_TOOLS_PIPE_PATH/);
});

test("env script and plist point at the installed paths with the stable label", () => {
  const renderedEnv = renderEnvScript({ wrapperPath: "/w", realPath: "/r", logPath: "/l" });
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
