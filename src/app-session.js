import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_STORAGE_PREFIX = Buffer.from("v10");

export function decryptSafeStorageString(encryptedBase64, password) {
  const encrypted = Buffer.from(encryptedBase64, "base64");
  if (!encrypted.subarray(0, 3).equals(SAFE_STORAGE_PREFIX)) {
    throw new Error("Unsupported Grok Bot Safe Storage format.");
  }

  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    key,
    Buffer.alloc(16, 32),
  );
  return Buffer.concat([
    decipher.update(encrypted.subarray(3)),
    decipher.final(),
  ]).toString("utf8");
}

export function grokBotGatewayDescriptorPath(home = homedir()) {
  return join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
}

export function hasGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
} = {}) {
  return platform === "darwin" && existsSync(grokBotGatewayDescriptorPath(home));
}

function readKeychainPassword() {
  return execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
    { encoding: "utf8" },
  ).trimEnd();
}

export function loadGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
  getKeychainPassword = readKeychainPassword,
} = {}) {
  if (platform !== "darwin") return null;

  const path = grokBotGatewayDescriptorPath(home);
  if (!existsSync(path)) return null;

  const wrapped = JSON.parse(readFileSync(path, "utf8"));
  const clear = decryptSafeStorageString(
    wrapped.encrypted,
    getKeychainPassword(),
  );
  const descriptor = JSON.parse(clear);
  if (!descriptor.baseUrl || !descriptor.token) {
    throw new Error("Grok Bot gateway descriptor is incomplete.");
  }

  return {
    gatewayUrl: String(descriptor.baseUrl).replace(/\/$/, ""),
    gatewayToken: String(descriptor.token),
    headers: descriptor.headers ?? {},
  };
}
