import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  hasGrokBotAppCredentials,
  loadGrokBotAppCredentials,
  grokBotAppVersion,
  decryptSafeStorageString,
  decryptWindowsSafeStorageString,
  grokBotGatewayDescriptorPath,
  hasGrokBotGatewaySession,
  inspectGrokBotGatewaySession,
  loadGrokBotGatewaySession,
} from "../src/core/app-session.js";

const ENCRYPTED_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnMK+c4czCXq82JKPNsdsP3Bp2fX8HoGPZFsa7k+JOmbIkBanQwl4yiy9v7iOA+mE4rtGqYbYD9jJc+/9YnhcGjvSxCxD8fKbJLbHifTwroGQ==";
const ENCRYPTED_INCOMPLETE_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnWb2TrPAofoKysOC2KnKLJ";
const WINDOWS_KEY = Buffer.from("demo-safe-storage-key-32-bytes!!");
const WINDOWS_ENCRYPTED_DESCRIPTOR =
  "djEwZGVtby1ub25jZTEyUN+Gpc6/+RfJzyx52epPxU9Qlzo9TQNAJD6QHtsCaTCTBxssiBtRPJzcylXxQTjOJdPlxMjVIjlxWhW7WfcfxPjJiVIr8J3dZZA7J1dF9uSYG6iDLXHAotC+0gDB7k81WdJmrbloEC+sslxz+AeU6VW3B5E5yYepIfkEdw==";
const WINDOWS_LOCAL_STATE = {
  os_crypt: { encrypted_key: Buffer.from("DPAPIdemo-dpapi-blob").toString("base64") },
};

function writeWrappedDescriptor(wrapped) {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify(wrapped));
  return home;
}

function writeWindowsAppData(
  localState,
  appData = mkdtempSync(join(tmpdir(), "gbot-appdata-")),
  wrapped = { version: 2, entries: { primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR } } },
) {
  const dir = join(appData, "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gateway-descriptor.json"),
    JSON.stringify(wrapped),
  );
  writeFileSync(join(dir, "Local State"), JSON.stringify(localState));
  return appData;
}

function unprotectDemoKey(blob) {
  assert.equal(blob.toString("utf8"), "demo-dpapi-blob");
  return WINDOWS_KEY;
}

test("decrypts an Electron Safe Storage v10 string", () => {
  const clear = decryptSafeStorageString(
    ENCRYPTED_DESCRIPTOR,
    "demo-password",
  );

  assert.deepEqual(JSON.parse(clear), {
    baseUrl: "https://box.example",
    token: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads the signed-in Grok Bot gateway without manual tokens", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(
    descriptorPath,
    JSON.stringify({ version: 1, encrypted: ENCRYPTED_DESCRIPTOR }),
  );

  const session = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

for (const version of [2, 3, 4]) {
  test(`loads a version ${version} Grok Bot gateway entry`, () => {
    const home = writeWrappedDescriptor({
      version,
      entries: {
        primary: {
          encrypted: ENCRYPTED_DESCRIPTOR,
          savedAtMs: 1_787_000_000_000,
        },
      },
    });

    const session = loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      now: () => 1_787_000_001_000,
      getKeychainPassword: () => "demo-password",
    });

    assert.deepEqual(session, {
      gatewayUrl: "https://box.example",
      gatewayToken: "gateway-token",
      headers: { "x-anyrun-network-token": "route-token" },
    });
    assert.deepEqual(inspectGrokBotGatewaySession({
      platform: "darwin",
      home,
      now: () => 1_787_000_001_000,
      getKeychainPassword: () => "demo-password",
    }), { present: true, usable: true });
  });

  test(`rejects a version ${version} descriptor with no entries`, () => {
    const home = writeWrappedDescriptor({ version, entries: {} });

    assert.throws(
      () => loadGrokBotGatewaySession({
        platform: "darwin",
        home,
        getKeychainPassword: () => "demo-password",
      }),
      (error) => {
        assert.equal(error.name, "GrokBotGatewaySessionError");
        assert.equal(error.code, "EMPTY_ENTRIES");
        assert.match(error.message, /no saved gateway entries/i);
        return true;
      },
    );
  });

  test(`rejects a version ${version} descriptor with ambiguous entries`, () => {
    const home = writeWrappedDescriptor({
      version,
      entries: {
        first: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 1 },
        second: { encrypted: ENCRYPTED_DESCRIPTOR, savedAtMs: 2 },
      },
    });

    assert.throws(
      () => loadGrokBotGatewaySession({
        platform: "darwin",
        home,
        getKeychainPassword: () => "demo-password",
      }),
      (error) => {
        assert.equal(error.name, "GrokBotGatewaySessionError");
        assert.equal(error.code, "AMBIGUOUS_ENTRIES");
        assert.match(error.message, /multiple saved gateway entries/i);
        return true;
      },
    );
  });

  test(`rejects a version ${version} gateway entry without an encrypted payload`, () => {
    const home = writeWrappedDescriptor({
      version,
      entries: { primary: { savedAtMs: 1 } },
    });

    assert.throws(
      () => loadGrokBotGatewaySession({
        platform: "darwin",
        home,
        getKeychainPassword: () => "demo-password",
      }),
      (error) => {
        assert.equal(error.name, "GrokBotGatewaySessionError");
        assert.equal(error.code, "MISSING_ENCRYPTED_PAYLOAD");
        assert.match(error.message, /missing an encrypted payload/i);
        return true;
      },
    );
  });
}

test("rejects an unsupported gateway descriptor version", () => {
  const home = writeWrappedDescriptor({
    version: 5,
    encrypted: ENCRYPTED_DESCRIPTOR,
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "UNSUPPORTED_VERSION");
      assert.match(error.message, /unsupported .*gateway descriptor version 5/i);
      return true;
    },
  );
});

test("rejects a version 4 gateway entry without a numeric savedAtMs timestamp before reading keychain", (t) => {
  const home = writeWrappedDescriptor({
    version: 4,
    entries: { primary: { encrypted: ENCRYPTED_DESCRIPTOR } },
  });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => assert.fail("Invalid v4 entry must not access the keychain"),
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "INVALID_ENTRY");
      assert.match(error.message, /savedAtMs/i);
      return true;
    },
  );
});

test("enforces the 7-day savedAtMs TTL on version 4 descriptors before touching the keychain", (t) => {
  const savedAtMs = 1_900_000_000_000;
  const sevenDaysMs = 10080 * 60 * 1000;
  const home = writeWrappedDescriptor({
    version: 4,
    entries: { primary: { savedAtMs, encrypted: ENCRYPTED_DESCRIPTOR } },
  });
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Exact boundary (now - savedAtMs === maxAgeMs) is still accepted.
  const ok = loadGrokBotGatewaySession({
    platform: "darwin",
    home,
    now: () => savedAtMs + sevenDaysMs,
    getKeychainPassword: () => "demo-password",
  });
  assert.equal(ok.gatewayToken, "gateway-token");

  // 1 ms past 7 days is expired without accessing the keychain.
  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      now: () => savedAtMs + sevenDaysMs + 1,
      getKeychainPassword: () => assert.fail("Expired v4 entry must not access the keychain"),
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "EXPIRED_DESCRIPTOR");
      return true;
    },
  );
});

test("loads a version 4 Linux descriptor with port/sand/authorization headers and respects authorizationRefreshAtMs", (t) => {
  const savedAtMs = 1_999_900_000_000;
  const payload = JSON.stringify({
    baseUrl: "https://box.example/",
    token: "v4-access-token",
    authorizationRefreshAtMs: 2_000_000_000_000,
    headers: {
      "x-anyrun-port-token": "v4-port-token",
      "x-sand-gateway-token": "v4-gateway-token",
      authorization: "Bearer v4-access-token",
    },
    egressTunnelHeaders: { "x-anyrun-port-token": "v4-egress-token" },
    vncDisabled: true,
  });
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "linux", {});
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({
    version: 4,
    entries: {
      primary: {
        savedAtMs,
        encrypted: encryptLinuxSafeStorage(payload, "v11", "keyring-password"),
      },
    },
  }));

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    now: () => 1_999_999_999_000,
    getKeychainPassword: () => "keyring-password",
  });
  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "v4-access-token",
    headers: {
      "x-anyrun-port-token": "v4-port-token",
      "x-sand-gateway-token": "v4-gateway-token",
      authorization: "Bearer v4-access-token",
    },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "linux",
      home,
      env: {},
      now: () => 2_000_000_000_000,
      getKeychainPassword: () => "keyring-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "EXPIRED_DESCRIPTOR");
      return true;
    },
  );
  assert.equal(
    inspectGrokBotGatewaySession({
      platform: "linux",
      home,
      env: {},
      now: () => 2_000_000_000_000,
      getKeychainPassword: () => "keyring-password",
    }).code,
    "EXPIRED_DESCRIPTOR",
  );
});

test("rejects a decrypted gateway descriptor with blank fields, invalid headers, or invalid authorizationRefreshAtMs", (t) => {
  for (const bad of [
    { baseUrl: "   ", token: "gw" },
    { baseUrl: "https://box.example", token: "   " },
    { baseUrl: "https://box.example", token: "gw", headers: ["not-a-map"] },
    { baseUrl: "https://box.example", token: "gw", headers: { "x-a": 123 } },
    { baseUrl: "https://box.example", token: "gw", authorizationRefreshAtMs: "soon" },
    { baseUrl: "https://box.example", token: "gw", authorizationRefreshAtMs: null },
  ]) {
    const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const descriptorPath = grokBotGatewayDescriptorPath(home, "linux", {});
    mkdirSync(dirname(descriptorPath), { recursive: true });
    writeFileSync(descriptorPath, JSON.stringify({
      version: 4,
      entries: {
        primary: {
          savedAtMs: 1_900_000_000_000,
          encrypted: encryptLinuxSafeStorage(JSON.stringify(bad), "v10", "peanuts"),
        },
      },
    }));
    assert.throws(
      () => loadGrokBotGatewaySession({ platform: "linux", home, env: {}, now: () => 1_900_000_001_000 }),
      (error) => error.name === "GrokBotGatewaySessionError" && error.code === "INCOMPLETE_DESCRIPTOR",
    );
  }
});

test("rejects an incomplete decrypted gateway descriptor", () => {
  const home = writeWrappedDescriptor({
    version: 2,
    entries: { primary: { encrypted: ENCRYPTED_INCOMPLETE_DESCRIPTOR } },
  });

  assert.throws(
    () => loadGrokBotGatewaySession({
      platform: "darwin",
      home,
      getKeychainPassword: () => "demo-password",
    }),
    (error) => {
      assert.equal(error.name, "GrokBotGatewaySessionError");
      assert.equal(error.code, "INCOMPLETE_DESCRIPTOR");
      assert.match(error.message, /decrypted .*gateway descriptor is incomplete/i);
      return true;
    },
  );
});

test("reports a present but unusable Grok Bot app session", () => {
  const home = writeWrappedDescriptor({ version: 2, entries: {} });

  const status = inspectGrokBotGatewaySession({
    platform: "darwin",
    home,
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(status, {
    present: true,
    usable: false,
    code: "EMPTY_ENTRIES",
    error: "Grok Bot gateway descriptor has no saved gateway entries.",
  });
});

function encryptLinuxSafeStorage(clear, prefix, password) {
  // Chromium OSCrypt on Linux: PBKDF2-SHA1, "saltysalt", ONE iteration, AES-128-CBC, IV = 16 spaces.
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([
    Buffer.from(prefix, "latin1"),
    cipher.update(clear, "utf8"),
    cipher.final(),
  ]).toString("base64");
}

const LINUX_DESCRIPTOR = JSON.stringify({
  baseUrl: "https://box.example/",
  token: "gateway-token",
  headers: { "x-anyrun-network-token": "route-token" },
});

function writeLinuxDescriptor(encrypted, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  const descriptorPath = grokBotGatewayDescriptorPath(home, "linux", env);
  mkdirSync(dirname(descriptorPath), { recursive: true });
  writeFileSync(descriptorPath, JSON.stringify({ version: 2, entries: { primary: { encrypted } } }));
  return home;
}

test("loads a Linux v11 descriptor with the Secret Service password", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v11", "keyring-password"),
  );
  let platformAsked = null;

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: (platform) => {
      platformAsked = platform;
      return "keyring-password";
    },
  });

  assert.equal(platformAsked, "linux");
  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads a Linux v10 (basic_text) descriptor without touching the keyring", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v10", "peanuts"),
  );
  let keychainRead = false;

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(keychainRead, false);
  assert.equal(session.gatewayToken, "gateway-token");
});

test("honours XDG_CONFIG_HOME for the Linux descriptor", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gbot-xdg-"));
  const env = { XDG_CONFIG_HOME: configHome };
  writeLinuxDescriptor(encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v10", "peanuts"), env);

  assert.equal(hasGrokBotGatewaySession({ platform: "linux", home: "/tmp/unused", env }), true);
  assert.equal(
    grokBotGatewayDescriptorPath("/tmp/unused", "linux", env),
    join(configHome, "Grok Bot/gateway-descriptor.json"),
  );
});

test("rejects a wrong Secret Service password on Linux as unusable", () => {
  const home = writeLinuxDescriptor(
    encryptLinuxSafeStorage(LINUX_DESCRIPTOR, "v11", "keyring-password"),
  );

  const status = inspectGrokBotGatewaySession({
    platform: "linux",
    home,
    env: {},
    getKeychainPassword: () => "wrong-password",
  });

  assert.equal(status.present, true);
  assert.equal(status.usable, false);
  assert.equal(status.code, "UNUSABLE_SESSION");
});

test("does not probe app credentials on unsupported platforms", () => {
  let keychainRead = false;

  const session = loadGrokBotGatewaySession({
    platform: "freebsd",
    home: "/tmp/unused",
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(session, null);
  assert.equal(keychainRead, false);
});

test("decrypts a Windows Electron Safe Storage v10 string", () => {
  const clear = decryptWindowsSafeStorageString(
    WINDOWS_ENCRYPTED_DESCRIPTOR,
    WINDOWS_KEY,
  );

  assert.deepEqual(JSON.parse(clear), {
    baseUrl: "https://box.example",
    token: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("loads the signed-in Grok Bot gateway on Windows", () => {
  const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE);

  const session = loadGrokBotGatewaySession({
    platform: "win32",
    home: "/tmp/unused",
    appData,
    unprotectData: unprotectDemoKey,
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

for (const version of [3, 4]) {
  test(`loads a version ${version} Windows descriptor through the DPAPI key provider`, () => {
    const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE, undefined, {
      version,
      entries: {
        primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR, savedAtMs: 1_791_320_229_049 },
      },
    });
    let keyReads = 0;

    const session = loadGrokBotGatewaySession({
      platform: "win32",
      home: "/tmp/unused",
      appData,
      now: () => 1_791_320_230_000,
      unprotectData: (blob) => {
        keyReads += 1;
        return unprotectDemoKey(blob);
      },
    });

    assert.equal(keyReads, 1);
    assert.deepEqual(session, {
      gatewayUrl: "https://box.example",
      gatewayToken: "gateway-token",
      headers: { "x-anyrun-network-token": "route-token" },
    });
  });

  test(`reports a version ${version} Windows app session as usable`, () => {
    const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE, undefined, {
      version,
      entries: { primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR, savedAtMs: 1 } },
    });

    assert.deepEqual(inspectGrokBotGatewaySession({
      platform: "win32",
      home: "/tmp/unused",
      appData,
      now: () => 2,
      unprotectData: unprotectDemoKey,
    }), { present: true, usable: true });
  });

  for (const [label, entries, code] of [
    ["empty entries", {}, "EMPTY_ENTRIES"],
    ["ambiguous entries", {
      first: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR, savedAtMs: 1 },
      second: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR, savedAtMs: 2 },
    }, "AMBIGUOUS_ENTRIES"],
    ["missing encrypted payload", { primary: { savedAtMs: 1 } }, "MISSING_ENCRYPTED_PAYLOAD"],
  ]) {
    test(`rejects version ${version} Windows ${label} before unprotecting the key`, () => {
      const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE, undefined, { version, entries });

      assert.throws(() => loadGrokBotGatewaySession({
        platform: "win32",
        home: "/tmp/unused",
        appData,
        now: () => 2,
        unprotectData: () => assert.fail("Invalid entries must not access the DPAPI key"),
      }), (error) => error.code === code);
    });
  }
}

for (const [label, entries, nowMs, code] of [
  ["missing savedAtMs", { primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR } }, 2, "INVALID_ENTRY"],
  ["expired savedAtMs", { primary: { encrypted: WINDOWS_ENCRYPTED_DESCRIPTOR, savedAtMs: 1 } }, 1 + 10080 * 60 * 1000 + 1, "EXPIRED_DESCRIPTOR"],
]) {
  test(`rejects version 4 Windows ${label} before unprotecting the DPAPI key`, (t) => {
    const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE, undefined, { version: 4, entries });
    t.after(() => rmSync(appData, { recursive: true, force: true }));

    assert.throws(() => loadGrokBotGatewaySession({
      platform: "win32",
      home: "/tmp/unused",
      appData,
      now: () => nowMs,
      unprotectData: () => assert.fail("Invalid or expired v4 entry must not access the DPAPI key"),
    }), (error) => error.code === code);
  });
}

test("rejects a version 3 Windows descriptor with a tampered authentication tag", () => {
  const tampered = Buffer.from(WINDOWS_ENCRYPTED_DESCRIPTOR, "base64");
  tampered[tampered.length - 1] ^= 1;
  const appData = writeWindowsAppData(WINDOWS_LOCAL_STATE, undefined, {
    version: 3,
    entries: { primary: { encrypted: tampered.toString("base64"), savedAtMs: 1 } },
  });

  const status = inspectGrokBotGatewaySession({
    platform: "win32",
    home: "/tmp/unused",
    appData,
    unprotectData: unprotectDemoKey,
  });

  assert.equal(status.present, true);
  assert.equal(status.usable, false);
  assert.equal(status.code, "UNUSABLE_SESSION");
});

test("falls back to AppData/Roaming under home when APPDATA is unset", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-home-"));
  writeWindowsAppData(WINDOWS_LOCAL_STATE, join(home, "AppData/Roaming"));

  const session = loadGrokBotGatewaySession({
    platform: "win32",
    home,
    appData: "",
    unprotectData: unprotectDemoKey,
  });

  assert.equal(session.gatewayUrl, "https://box.example");
});

test("reports a Windows app session without a Safe Storage key", () => {
  const appData = writeWindowsAppData({ os_crypt: {} });

  const status = inspectGrokBotGatewaySession({
    platform: "win32",
    home: "/tmp/unused",
    appData,
    unprotectData: unprotectDemoKey,
  });

  assert.deepEqual(status, {
    present: true,
    usable: false,
    code: "MISSING_SAFE_STORAGE_KEY",
    error: "Grok Bot Local State has no Safe Storage key.",
  });
});

function writeActiveAccount(active = "selected", version = 1) {
  const home = mkdtempSync(join(tmpdir(), "gbot-active-"));
  const dir = join(home, ".config/Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sand-secrets.json"), JSON.stringify({ version,
    "cursor-accounts": JSON.stringify({ active, accounts: {
      selected: { "cursor-access-token": encryptLinuxSafeStorage("selected-token", "v10", "peanuts"),
        "cursor-selected-team-id": encryptLinuxSafeStorage("42", "v10", "peanuts") },
      other: { "cursor-access-token": encryptLinuxSafeStorage("wrong-account-token", "v10", "peanuts") },
    } }),
  }));
  return { home, platform: "linux", env: {}, getKeychainPassword: () => { throw new Error("must not ask keyring for basic_text"); } };
}

test("missing route reconnect credentials select only the active account and its team", () => {
  const opts = writeActiveAccount();
  assert.equal(hasGrokBotGatewaySession(opts), false);
  assert.equal(hasGrokBotAppCredentials(opts), true);
  assert.deepEqual(loadGrokBotAppCredentials(opts), { accessToken: "selected-token", accountKey: "selected", teamId: "42" });
});

for (const active of [null, "missing"]) {
  test(`does not restore inactive saved accounts when active is ${active}`, () => {
    const opts = writeActiveAccount(active);
    assert.equal(hasGrokBotAppCredentials(opts), false);
    assert.equal(loadGrokBotAppCredentials(opts), null);
  });
}

function encryptWindowsSafeStorage(clear, key = WINDOWS_KEY) {
  const nonce = Buffer.from("demo-nonce12");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(clear, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]).toString("base64");
}

// Mirrors Grok Bot 0.70.x on Windows: no gateway-descriptor.json, and the
// active account record carries no selected team.
function writeWindowsActiveAccount(localState = WINDOWS_LOCAL_STATE) {
  const appData = mkdtempSync(join(tmpdir(), "gbot-win-active-"));
  const dir = join(appData, "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Local State"), JSON.stringify(localState));
  writeFileSync(join(dir, "sand-secrets.json"), JSON.stringify({
    version: 1,
    "cursor-machine-id": encryptWindowsSafeStorage("machine"),
    "cursor-accounts": JSON.stringify({ active: "selected", accounts: {
      selected: {
        "cursor-access-token": encryptWindowsSafeStorage("selected-token"),
        "cursor-account-profile": encryptWindowsSafeStorage("{}"),
        "cursor-refresh-token": encryptWindowsSafeStorage("refresh"),
      },
      other: { "cursor-access-token": encryptWindowsSafeStorage("wrong-account-token") },
    } }),
  }));
  return { platform: "win32", home: "/tmp/unused", appData, unprotectData: unprotectDemoKey };
}

test("Windows: reconnect credentials come from the active account via the DPAPI Safe Storage key", () => {
  const opts = writeWindowsActiveAccount();
  assert.equal(hasGrokBotGatewaySession(opts), false);
  assert.equal(hasGrokBotAppCredentials(opts), true);
  assert.deepEqual(loadGrokBotAppCredentials(opts), { accessToken: "selected-token", accountKey: "selected" });
});

test("Windows: reconnect credentials need the Safe Storage key", () => {
  const opts = writeWindowsActiveAccount({ os_crypt: {} });
  assert.equal(hasGrokBotAppCredentials(opts), true);
  assert.throws(() => loadGrokBotAppCredentials(opts), (error) => {
    assert.equal(error.code, "MISSING_SAFE_STORAGE_KEY");
    return true;
  });
});

test("does not interpret unknown credential store versions", () => {
  const opts = writeActiveAccount("selected", 99);
  assert.equal(hasGrokBotAppCredentials(opts), false);
  assert.throws(() => loadGrokBotAppCredentials(opts), { code: "UNSUPPORTED_CREDENTIALS" });
});

test("reports the running app version from desktop-status.json on every platform", () => {
  const appData = mkdtempSync(join(tmpdir(), "gbot-status-"));
  const dir = join(appData, "Grok Bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "desktop-status.json"), JSON.stringify({ version: 1, pid: 1, appVersion: "0.70.2", signedIn: true }));
  assert.equal(grokBotAppVersion({ platform: "win32", home: "/tmp/unused", appData }), "0.70.2");

  const home = mkdtempSync(join(tmpdir(), "gbot-status-home-"));
  const linuxDir = join(home, ".config/Grok Bot");
  mkdirSync(linuxDir, { recursive: true });
  writeFileSync(join(linuxDir, "desktop-status.json"), JSON.stringify({ appVersion: "not a version" }));
  assert.equal(grokBotAppVersion({ platform: "linux", home, env: {} }), null);
});

test("detects installed macOS app version instead of a fixed backend version", () => {
  const home = mkdtempSync(join(tmpdir(), "gbot-version-"));
  const dir = join(home, "Applications/Grok Bot.app/Contents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.68.1</string></dict></plist>`);
  if (process.platform === "darwin") assert.equal(grokBotAppVersion({ home, platform: "darwin" }), "0.68.1");
  assert.equal(grokBotAppVersion({ home, platform: "linux" }), null);
});
