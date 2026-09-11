import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  decryptSafeStorageString,
  grokBotGatewayDescriptorPath,
  hasGrokBotGatewaySession,
  inspectGrokBotGatewaySession,
  loadGrokBotGatewaySession,
} from "../src/app-session.js";

const ENCRYPTED_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnMK+c4czCXq82JKPNsdsP3Bp2fX8HoGPZFsa7k+JOmbIkBanQwl4yiy9v7iOA+mE4rtGqYbYD9jJc+/9YnhcGjvSxCxD8fKbJLbHifTwroGQ==";
const ENCRYPTED_INCOMPLETE_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnWb2TrPAofoKysOC2KnKLJ";

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

test("loads a version 2 Grok Bot gateway entry", () => {
  const home = writeWrappedDescriptor({
    version: 2,
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
    getKeychainPassword: () => "demo-password",
  });

  assert.deepEqual(session, {
    gatewayUrl: "https://box.example",
    gatewayToken: "gateway-token",
    headers: { "x-anyrun-network-token": "route-token" },
  });
});

test("rejects a version 2 descriptor with no entries", () => {
  const home = writeWrappedDescriptor({ version: 2, entries: {} });

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

test("rejects a version 2 descriptor with ambiguous entries", () => {
  const home = writeWrappedDescriptor({
    version: 2,
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

test("rejects a gateway entry without an encrypted payload", () => {
  const home = writeWrappedDescriptor({
    version: 2,
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

test("rejects an unsupported gateway descriptor version", () => {
  const home = writeWrappedDescriptor({
    version: 3,
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
      assert.match(error.message, /unsupported .*gateway descriptor version 3/i);
      return true;
    },
  );
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
    platform: "win32",
    home: "/tmp/unused",
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(session, null);
  assert.equal(keychainRead, false);
});
