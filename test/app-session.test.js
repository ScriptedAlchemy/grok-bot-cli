import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  decryptSafeStorageString,
  loadGrokBotGatewaySession,
} from "../src/app-session.js";

const ENCRYPTED_DESCRIPTOR =
  "djEwddBm+U69UF2IJtIUtedNqMB3bQt7HsRw7MLWRkw/IfnMK+c4czCXq82JKPNsdsP3Bp2fX8HoGPZFsa7k+JOmbIkBanQwl4yiy9v7iOA+mE4rtGqYbYD9jJc+/9YnhcGjvSxCxD8fKbJLbHifTwroGQ==";

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

test("does not probe macOS credentials on other platforms", () => {
  let keychainRead = false;

  const session = loadGrokBotGatewaySession({
    platform: "linux",
    home: "/tmp/unused",
    getKeychainPassword: () => {
      keychainRead = true;
      return "unused";
    },
  });

  assert.equal(session, null);
  assert.equal(keychainRead, false);
});
