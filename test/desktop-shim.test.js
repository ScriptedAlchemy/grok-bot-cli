import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
    codexHome: "/b",
    realPath: "/r/codex",
    wrapperLogPath: "/b/w.log",
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

test("wrapper never blocks Desktop on daemon start", () => {
  const script = renderWrapperScript({
    bridgeLogPath: "/b/bridge.log",
    bridgePath: "/b/bridge.py",
    codexHome: "/b",
    realPath: "/r/codex",
    wrapperLogPath: "/b/w.log",
  });
  // Daemon upkeep belongs to the LaunchAgent login script; a synchronous
  // `daemon start` here could wedge on the daemon lock and hang Desktop.
  assert.doesNotMatch(script, /daemon start/);
});

test("wrapper preflights the socket and runs the bridge as a fallible child", () => {
  const script = renderWrapperScript({
    bridgeLogPath: "/b/bridge.log",
    bridgePath: "/b/bridge.py",
    codexHome: "/b",
    realPath: "/r/codex",
    wrapperLogPath: "/b/w.log",
  });
  // No `exec python3`: exec would replace the wrapper before connect, so a
  // failed connect could never reach the fallback.
  assert.doesNotMatch(script, /exec python3/);
  assert.match(script, /preflight\(\)/);
  assert.match(script, /CODEX_DESKTOP_PREFLIGHT_TIMEOUT/);
  assert.match(script, /python3 "\$BRIDGE"\n\s+rc=\$\?/);
  assert.match(script, /case "\$rc" in/);
  // Exit 1 (pre-stdio) falls through; exit 2+ (mid-session) exits promptly so
  // Desktop reconnects instead of running real Codex on half-consumed stdin.
  assert.match(script, /bridge failed before session start, falling through to real codex/);
  assert.match(script, /bridge failed mid-session.*exiting so Desktop reconnects/);
});

test("wrapper exports CODEX_HOME and derives the socket from it at runtime", () => {
  const custom = defaultPaths({ env: { CODEX_HOME: "/tmp/custom-home", HOME: "/tmp/u" }, home: "/tmp/u" });
  const script = renderWrapperScript(custom);
  assert.ok(custom.socketPath.startsWith("/tmp/custom-home"));
  assert.match(script, /export CODEX_HOME="\$\{CODEX_HOME:-\/tmp\/custom-home\}"/);
  assert.match(script, /SOCK="\$\{CODEX_APP_SERVER_SOCK:-\$CODEX_HOME\/app-server-control\/app-server-control\.sock\}"/);
  assert.match(script, /export CODEX_APP_SERVER_SOCK="\$SOCK"/);
  assert.ok(script.includes(`BRIDGE_LOG="\${CODEX_STDIO_BRIDGE_LOG:-${custom.bridgeLogPath}}"`));

  const fallback = defaultPaths({ env: { HOME: "/tmp/u" }, home: "/tmp/u" });
  const fallbackScript = renderWrapperScript(fallback);
  assert.match(
    fallbackScript,
    /export CODEX_HOME="\$\{CODEX_HOME:-\/tmp\/u\/\.codex\}"/,
  );
});

test("vendored bridge enforces an absolute handshake deadline and validates upgrade", () => {
  assert.match(BRIDGE_SOURCE, /CODEX_BRIDGE_CONNECT_TIMEOUT/);
  assert.match(BRIDGE_SOURCE, /time\.monotonic/);
  assert.match(BRIDGE_SOURCE, /sec-websocket-accept/);
  assert.match(BRIDGE_SOURCE, /accept mismatch/);
  assert.match(BRIDGE_SOURCE, /read_message/);
  assert.match(BRIDGE_SOURCE, /EXIT_PRE_STDIO/);
  assert.match(BRIDGE_SOURCE, /EXIT_MID_SESSION/);
});

test("vendored bridge is the proven stdio-ws bridge, verbatim", () => {
  assert.ok(BRIDGE_SOURCE.startsWith("#!/usr/bin/env python3"));
  assert.match(BRIDGE_SOURCE, /app-server-control\.sock/);
  assert.doesNotMatch(BRIDGE_SOURCE, /codex-browser-use/);
  assert.doesNotMatch(BRIDGE_SOURCE, /CODEX_APP_TOOLS_PIPE_PATH/);
});

test("env script and plist point at the installed paths with the stable label", () => {
  const renderedEnv = renderEnvScript({ codexHome: "/c", envLogPath: "/l", realPath: "/r", wrapperPath: "/w" });
  assert.match(renderedEnv, /launchctl setenv CODEX_CLI_PATH/);
  assert.match(renderedEnv, /launchctl setenv CODEX_HOME "\$CODEX_HOME_DIR"/);
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

/** Render a runnable wrapper wired to a fake real codex in dir. The socket is
 * selected at runtime through CODEX_APP_SERVER_SOCK, which also proves the
 * operator-override chain end to end. */
function stageWrapper(dir, { bridgePath }) {
  const realPath = join(dir, "real-codex");
  writeFileSync(realPath, '#!/bin/bash\necho "FAKE-REAL argv: $*"\n');
  chmodSync(realPath, 0o755);
  const wrapperPath = join(dir, "wrapper.sh");
  const script = renderWrapperScript({
    bridgeLogPath: join(dir, "bridge.log"),
    bridgePath,
    codexHome: dir,
    realPath,
    wrapperLogPath: join(dir, "wrapper.log"),
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
  const { wrapperPath } = stageWrapper(dir, { bridgePath });
  const out = runWrapper(wrapperPath, ["app-server"], { CODEX_APP_SERVER_SOCK: join(dir, "no-such.sock") });
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
    const { wrapperPath } = stageWrapper(dir, { bridgePath });
    const started = Date.now();
    const out = runWrapper(wrapperPath, ["app-server"], {
      CODEX_APP_SERVER_SOCK: socketPath,
      CODEX_BRIDGE_CONNECT_TIMEOUT: "1",
    });
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
    const { wrapperPath } = stageWrapper(dir, { bridgePath });
    const out = runWrapper(wrapperPath, ["app-server"], { CODEX_APP_SERVER_SOCK: socketPath });
    assert.equal(out.status, 0);
    assert.doesNotMatch(out.stdout, /FAKE-REAL/);
  } finally {
    server.close();
  }
});

test("wrapper never falls back after the bridge consumed stdin", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-mid-"));
  const socketPath = join(dir, "preflight-ok.sock");
  const server = await silentListener(socketPath);
  try {
    // Reads one stdin line then dies mid-session (exit 2) with half-consumed
    // stdin. The wrapper must exit promptly with that code and must never
    // exec real Codex onto a corrupted stream.
    const bridgePath = join(dir, "bridge-mid.py");
    writeFileSync(bridgePath, "#!/usr/bin/env python3\nimport sys; sys.stdin.readline(); sys.exit(2)\n");
    const { wrapperPath } = stageWrapper(dir, { bridgePath });
    const out = spawnSync("bash", [wrapperPath, "app-server"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_APP_SERVER_SOCK: socketPath },
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      timeout: 60000,
    });
    assert.equal(out.status, 2);
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

test("socket resolution agrees: CODEX_APP_SERVER_SOCK wins, else CODEX_HOME", async () => {
  const { codexSocketPath } = await import("../src/core/codex-bridge.js");
  assert.equal(
    codexSocketPath({ CODEX_APP_SERVER_SOCK: "/custom/sock", CODEX_HOME: "/ignored" }),
    "/custom/sock",
  );
  assert.equal(
    codexSocketPath({ CODEX_HOME: "/ch" }),
    join("/ch", "app-server-control", "app-server-control.sock"),
  );
});

test("status reports the effective socket and its source", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-shim-sock-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "gbot-shim-sock-codex-"));
  const viaHome = desktopShimStatus({ env: { CODEX_HOME: codexHome, HOME: home }, home, platform: "linux" });
  assert.equal(viaHome.socketPath, join(codexHome, "app-server-control", "app-server-control.sock"));
  assert.equal(viaHome.socketSource, "CODEX_HOME");

  const viaSock = desktopShimStatus({
    env: { CODEX_APP_SERVER_SOCK: "/explicit/sock", CODEX_HOME: codexHome, HOME: home },
    home,
    platform: "linux",
  });
  assert.equal(viaSock.socketPath, "/explicit/sock");
  assert.equal(viaSock.socketSource, "CODEX_APP_SERVER_SOCK");
});

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Unmasked server-to-client WS frame. */
function wsServerFrame(opcode, payload, fin = true) {
  const head = Buffer.alloc(payload.length < 126 ? 2 : 4);
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126) head[1] = payload.length;
  else {
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([head, payload]);
}

/**
 * Fake managed daemon: answers the HTTP upgrade (valid accept unless told
 * otherwise), then emits `prelude` bytes coalesced right after the headers.
 * With `quiet`, it holds the connection silently (first-RPC scenarios); with
 * `closeAfterMs`, it destroys the connection after that delay. Returns the
 * socket path plus mutable connection state for assertions.
 */
async function fakeWsDaemon(dir, name, { validAccept = true, prelude = Buffer.alloc(0), quiet = false, closeAfterMs = null } = {}) {
  const socketPath = join(dir, name);
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  const state = { received: Buffer.alloc(0), socketPath };
  const server = createServer((socket) => {
    state.socket = socket;
    socket.on("error", () => {});
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (state.upgraded) {
        state.received = Buffer.concat([state.received, chunk]);
        return;
      }
      request = Buffer.concat([request, chunk]);
      if (!request.includes("\r\n\r\n")) return;
      const keyLine = request.toString("latin1").split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine.split(":")[1].trim();
      const accept = validAccept
        ? createHash("sha1").update(key + WS_GUID).digest().toString("base64")
        : "bogus";
      state.upgraded = true;
      socket.write(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            "latin1",
          ),
          prelude,
        ]),
      );
      if (quiet) return;
      if (closeAfterMs !== null) {
        setTimeout(() => {
          try {
            socket.destroy();
          } catch {}
        }, closeAfterMs).unref();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  state.server = server;
  return state;
}

const runBridge = (bridgePath, dir, env, input, { leaveStdinOpen = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("python3", [bridgePath], {
      env: {
        ...process.env,
        CODEX_STDIO_BRIDGE_LOG: join(dir, "bridge.log"),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bridge hung: stdout=${stdout} stderr=${stderr}`));
    }, 25000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    if (!leaveStdinOpen) child.stdin.end();
  });

const closeDaemon = async (daemon) => {
  try {
    daemon.socket?.destroy();
  } catch {}
  await new Promise((resolve) => daemon.server.close(resolve));
};

const writeBridge = (dir) => {
  const bridgePath = join(dir, "codex-stdio-to-daemon-ws.py");
  writeFileSync(bridgePath, BRIDGE_SOURCE);
  return bridgePath;
};

test("bridge keeps frames coalesced with the upgrade and assembles continuations", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-frames-"));
  const daemon = await fakeWsDaemon(dir, "frames.sock", {
    prelude: Buffer.concat([
      wsServerFrame(0x1, Buffer.from('{"ok":true}')),
      wsServerFrame(0x1, Buffer.from("hel"), false),
      wsServerFrame(0x0, Buffer.from("lo"), true),
    ]),
  });
  try {
    const out = await runBridge(writeBridge(dir), dir, { CODEX_APP_SERVER_SOCK: daemon.socketPath },
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.split("\n").filter(Boolean);
    assert.ok(lines.some((line) => line === '{"ok":true}'), `trailing frame kept, got: ${out.stdout}`);
    assert.ok(lines.some((line) => line === "hello"), `continuation assembled, got: ${out.stdout}`);
    assert.ok(daemon.received.length > 0, "stdin line forwarded to the daemon");
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge exits pre-stdio when the upgrade accept is wrong", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-accept-"));
  const daemon = await fakeWsDaemon(dir, "accept.sock", { validAccept: false });
  try {
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, { CODEX_APP_SERVER_SOCK: daemon.socketPath }, "");
    assert.equal(out.status, 1);
    assert.ok(Date.now() - started < 20000, "accept mismatch fails fast");
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge absolute deadline fires against a trickling handshake", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-trickle-"));
  const socketPath = join(dir, "trickle.sock");
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  // Accepts and reads the request, then trickles forever: per-operation
  // timeouts never fire because bytes keep arriving, so only an absolute
  // monotonic deadline can bound this.
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let request = Buffer.alloc(0);
    const timer = setInterval(() => {
      try {
        socket.write(Buffer.from("X"));
      } catch {}
    }, 300);
    timer.unref();
    socket.on("close", () => clearInterval(timer));
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, {
      CODEX_APP_SERVER_SOCK: socketPath,
      CODEX_BRIDGE_CONNECT_TIMEOUT: "2",
    }, "");
    const elapsed = Date.now() - started;
    assert.equal(out.status, 1);
    assert.ok(elapsed < 15000, `absolute deadline must fire, took ${elapsed}ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge first-RPC deadline fails pre-stdio when stdin stays silent", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-firstrpc-"));
  const daemon = await fakeWsDaemon(dir, "quiet.sock", { quiet: true });
  try {
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, {
      CODEX_APP_SERVER_SOCK: daemon.socketPath,
      CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT: "2",
    }, "", { leaveStdinOpen: true });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 1);
    assert.ok(elapsed < 15000, `first-RPC deadline must fire pre-stdio, took ${elapsed}ms`);
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge first-RPC deadline exits mid-session after stdin was consumed", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-firstrpc2-"));
  const daemon = await fakeWsDaemon(dir, "quiet2.sock", { quiet: true });
  try {
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, {
      CODEX_APP_SERVER_SOCK: daemon.socketPath,
      CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT: "2",
    }, '{"id":1}\n', { leaveStdinOpen: true });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 2);
    assert.ok(elapsed < 15000, `first-RPC deadline must fire mid-session, took ${elapsed}ms`);
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge counts an unforwarded blank line as committed stdin", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-bytes-"));
  const daemon = await fakeWsDaemon(dir, "close.sock", { closeAfterMs: 500 });
  try {
    // One blank line is read but never forwarded; when the daemon then dies,
    // the fallback must not run: a byte left the pipe, so stdio is not pristine.
    const out = await runBridge(writeBridge(dir), dir,
      { CODEX_APP_SERVER_SOCK: daemon.socketPath }, "\n", { leaveStdinOpen: true });
    assert.equal(out.status, 2);
  } finally {
    await closeDaemon(daemon);
  }
});

test("vendored bridge pins the first-RPC deadline and byte-precise commit", () => {
  assert.match(BRIDGE_SOURCE, /CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT/);
  assert.match(BRIDGE_SOURCE, /stdin_bytes/);
  assert.match(BRIDGE_SOURCE, /os\.read/);
  assert.match(BRIDGE_SOURCE, /first_msg/);
});

test("login script keeps one CODEX_HOME for GUI env and daemon upkeep", () => {
  const renderedEnv = renderEnvScript({ codexHome: "/c", envLogPath: "/l", realPath: "/r", wrapperPath: "/w" });
  assert.match(renderedEnv, /export CODEX_HOME="\$CODEX_HOME_DIR"/);
  assert.match(renderedEnv, /CODEX_HOME_DIR="\/c"/);
  assert.match(renderedEnv, /launchctl setenv CODEX_HOME "\$CODEX_HOME_DIR"/);
});

test("vendored bridge bounds every send/lock with the session budget", () => {
  assert.match(BRIDGE_SOURCE, /lock\.acquire\(timeout/);
  assert.match(BRIDGE_SOURCE, /send budget expired|send lock timed out/);
  assert.match(BRIDGE_SOURCE, /sock\.settimeout\(timeout\)/);
  assert.match(BRIDGE_SOURCE, /_send_timeout/);
});

test("bridge first-message timer tracks the first response, not any notification", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-notif-"));
  // An unrelated notification must not disable the first-RPC timer while
  // initialize never gets a response. The notification is forwarded (stdout
  // becomes used), so the timeout exit is mid-session, never a stock fallback.
  const daemon = await fakeWsDaemon(dir, "notif.sock", {
    prelude: wsServerFrame(0x1, Buffer.from('{"jsonrpc":"2.0","method":"daemon/event","params":{}}')),
    quiet: true,
  });
  try {
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, {
      CODEX_APP_SERVER_SOCK: daemon.socketPath,
      CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT: "2",
    }, "", { leaveStdinOpen: true });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 2, `notification must not satisfy first-RPC; got ${out.status} ${out.stderr}`);
    assert.match(out.stdout, /daemon\/event/);
    assert.ok(elapsed < 15000, `first-response deadline must fire, took ${elapsed}ms`);
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge never falls back to stock after forwarding daemon output", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-used-stdout-"));
  // Astra repro: forwarded notification then close with pristine stdin must
  // exit mid-session (Desktop reconnects), never pre-stdio stock fallback.
  const daemon = await fakeWsDaemon(dir, "used.sock", {
    prelude: wsServerFrame(0x1, Buffer.from('{"jsonrpc":"2.0","method":"daemon/event","params":{}}')),
    closeAfterMs: 500,
  });
  try {
    const out = await runBridge(writeBridge(dir), dir,
      { CODEX_APP_SERVER_SOCK: daemon.socketPath }, "", { leaveStdinOpen: true });
    assert.match(out.stdout, /daemon\/event/);
    assert.equal(out.status, 2, `used stdout must force mid-session, got ${out.status}`);
  } finally {
    await closeDaemon(daemon);
  }
});

test("bridge large stdin to a non-reading peer times out instead of hanging", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-nonreading-"));
  const socketPath = join(dir, "nonreading.sock");
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  // Upgrade succeeds, then the peer never reads again: small pong/close
  // frames would fit the kernel buffer, so fill it with a multi-MB stdin line.
  // Unbounded sendall + lock would hang here past the test timeout.
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let request = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (upgraded) return; // non-reading: drop everything after the upgrade
      request = Buffer.concat([request, chunk]);
      if (!request.includes("\r\n\r\n")) return;
      const keyLine = request.toString("latin1").split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine.split(":")[1].trim();
      const accept = createHash("sha1").update(key + WS_GUID).digest().toString("base64");
      upgraded = true;
      socket.write(Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        "latin1",
      ));
      socket.pause(); // never consume stat frame reads; bridge sends must time out
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const bigLine = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"${"x".repeat(4 * 1024 * 1024)}"}}\n`;
    const started = Date.now();
    const out = await runBridge(writeBridge(dir), dir, {
      CODEX_APP_SERVER_SOCK: socketPath,
      CODEX_BRIDGE_CONNECT_TIMEOUT: "2",
      CODEX_BRIDGE_FIRST_MESSAGE_TIMEOUT: "2",
    }, bigLine, { leaveStdinOpen: true });
    const elapsed = Date.now() - started;
    assert.equal(out.status, 2, `bounded send must exit mid-session, got ${out.status}`);
    assert.ok(elapsed < 15000, `bounded send must not hang, took ${elapsed}ms`);
  } finally {
    for (const s of sockets) try { s.destroy(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge rejects HTTP 200 even with a valid accept hash", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-200-"));
  const socketPath = join(dir, "http200.sock");
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  const sockets200 = new Set();
  const server = createServer((socket) => {
    sockets200.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets200.delete(socket));
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (!request.includes("\r\n\r\n")) return;
      const keyLine = request.toString("latin1").split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine.split(":")[1].trim();
      const accept = createHash("sha1").update(key + WS_GUID).digest().toString("base64");
      // Valid accept, wrong status: must still fail (require 101 + accept).
      socket.write(Buffer.from(
        `HTTP/1.1 200 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        "latin1",
      ));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    const out = await runBridge(writeBridge(dir), dir,
      { CODEX_APP_SERVER_SOCK: socketPath }, "", { leaveStdinOpen: false });
    assert.equal(out.status, 1, `HTTP 200 must fail pre-stdio, got ${out.status}`);
  } finally {
    for (const s of sockets200) try { s.destroy(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});

test("bridge flushes buffered EOF-tail data before the WS Close", {
  skip: !canRunShellBridge && "needs bash + python3",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbot-shim-eoftail-"));
  const socketPath = join(dir, "eoftail.sock");
  try {
    rmSync(socketPath, { force: true });
  } catch {}
  // Closes the transport as soon as a WS Close frame arrives: a tail sent
  // after Close would be lost, so order proves the flush happens first.
  const state = { frames: [] };
  const server = createServer((socket) => {
    state.socket = socket;
    socket.on("error", () => {});
    let request = Buffer.alloc(0);
    let upgraded = false;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!upgraded) {
        request = Buffer.concat([request, chunk]);
        if (!request.includes("\r\n\r\n")) return;
        const keyLine = request.toString("latin1").split("\r\n")
          .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
        const key = keyLine.split(":")[1].trim();
        const accept = createHash("sha1").update(key + WS_GUID).digest().toString("base64");
        upgraded = true;
        socket.write(Buffer.from(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
          "latin1",
        ));
        const rest = request.subarray(request.indexOf("\r\n\r\n") + 4);
        if (rest.length) buf = Buffer.concat([buf, rest]);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.subarray(off, off + 4);
          payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        }
        state.frames.push({ opcode, payload: Buffer.from(payload) });
        buf = buf.subarray(off + maskLen + len);
        if (opcode === 0x8) {
          try { socket.destroy(); } catch {}
          return;
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    // Partial line with no newline at EOF: only the tail flush can deliver it.
    const out = await runBridge(writeBridge(dir), dir,
      { CODEX_APP_SERVER_SOCK: socketPath }, '{"id":1}', { leaveStdinOpen: false });
    assert.equal(out.status, 0, `clean EOF serves, got ${out.status} ${out.stderr}`);
    const dataIdx = state.frames.findIndex((f) => f.opcode === 0x1 && f.payload.toString().includes('"id":1'));
    const closeIdx = state.frames.findIndex((f) => f.opcode === 0x8);
    assert.ok(dataIdx !== -1, `EOF tail must reach the daemon, saw ${JSON.stringify(state.frames.map((f) => f.opcode))}`);
    assert.ok(closeIdx !== -1, "WS Close must still be sent");
    assert.ok(dataIdx < closeIdx, "tail data must precede the WS Close");
  } finally {
    try { state.socket?.destroy(); } catch {}
    await new Promise((resolve) => server.close(resolve));
  }
});

test("vendored bridge pins response-tracked first-RPC, output commit, and strict 101", () => {
  assert.match(BRIDGE_SOURCE, /_is_daemon_response/);
  assert.match(BRIDGE_SOURCE, /output_forwarded/);
  assert.match(BRIDGE_SOURCE, /startswith\(b"HTTP\/1\.1 101"\)/);
  assert.match(BRIDGE_SOURCE, /tail.*before.*WS Close|before the WS Close/s);
});
