import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAFE_STORAGE_PREFIX = Buffer.from("v10");

export class GrokBotGatewaySessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GrokBotGatewaySessionError";
    this.code = code;
  }
}

function encryptedPayload(wrapped) {
  if (wrapped.version != null && wrapped.version !== 1 && wrapped.version !== 2) {
    throw new GrokBotGatewaySessionError(
      "UNSUPPORTED_VERSION",
      `Unsupported Grok Bot gateway descriptor version ${wrapped.version}.`,
    );
  }
  let encrypted;
  if (wrapped.version === 2) {
    const entries = Object.values(wrapped.entries ?? {});
    if (entries.length === 0) {
      throw new GrokBotGatewaySessionError(
        "EMPTY_ENTRIES",
        "Grok Bot gateway descriptor has no saved gateway entries.",
      );
    }
    if (entries.length > 1) {
      throw new GrokBotGatewaySessionError(
        "AMBIGUOUS_ENTRIES",
        "Grok Bot gateway descriptor has multiple saved gateway entries and no active entry selection.",
      );
    }
    encrypted = entries[0]?.encrypted;
  } else {
    encrypted = wrapped.encrypted;
  }
  if (typeof encrypted !== "string" || !encrypted) {
    throw new GrokBotGatewaySessionError(
      "MISSING_ENCRYPTED_PAYLOAD",
      "Grok Bot gateway descriptor is missing an encrypted payload.",
    );
  }
  return encrypted;
}

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
  const encrypted = encryptedPayload(wrapped);
  const clear = decryptSafeStorageString(
    encrypted,
    getKeychainPassword(),
  );
  const descriptor = JSON.parse(clear);
  if (!descriptor.baseUrl || !descriptor.token) {
    throw new GrokBotGatewaySessionError(
      "INCOMPLETE_DESCRIPTOR",
      "Decrypted Grok Bot gateway descriptor is incomplete.",
    );
  }

  return {
    gatewayUrl: String(descriptor.baseUrl).replace(/\/$/, ""),
    gatewayToken: String(descriptor.token),
    headers: descriptor.headers ?? {},
  };
}

export function inspectGrokBotGatewaySession(options = {}) {
  if (!hasGrokBotGatewaySession(options)) {
    return { present: false, usable: false };
  }
  try {
    loadGrokBotGatewaySession(options);
    return { present: true, usable: true };
  } catch (error) {
    return {
      present: true,
      usable: false,
      code: error instanceof GrokBotGatewaySessionError ? error.code : "UNUSABLE_SESSION",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
