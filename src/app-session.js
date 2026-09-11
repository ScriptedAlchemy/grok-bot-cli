import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Chromium OSCrypt: "v10" = fixed password (macOS: the Keychain password; Linux: "peanuts"),
// "v11" = Linux Secret Service password. macOS stretches with 1003 PBKDF2 rounds, Linux with 1.
const SAFE_STORAGE_PREFIX_V10 = "v10";
const SAFE_STORAGE_PREFIX_V11 = "v11";
const LINUX_BASIC_TEXT_PASSWORD = "peanuts";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);

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

function safeStorageKey(password, platform) {
  const iterations = platform === "linux" ? 1 : 1003;
  return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

export function decryptSafeStorageString(encryptedBase64, password, platform = "darwin") {
  const encrypted = Buffer.from(encryptedBase64, "base64");
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  const linuxBasicText = platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V10;
  const keyring = prefix === SAFE_STORAGE_PREFIX_V10 || (platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V11);
  if (!keyring) {
    throw new Error("Unsupported Grok Bot Safe Storage format.");
  }

  const key = safeStorageKey(linuxBasicText ? LINUX_BASIC_TEXT_PASSWORD : password, platform);
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

export function grokBotGatewayDescriptorPath(home = homedir(), platform = process.platform, env = process.env) {
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
    return join(configHome, "Grok Bot/gateway-descriptor.json");
  }
  return join(
    home,
    "Library/Application Support/Grok Bot/gateway-descriptor.json",
  );
}

export function hasGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  return SUPPORTED_PLATFORMS.has(platform) && existsSync(grokBotGatewayDescriptorPath(home, platform, env));
}

function readKeychainPassword(platform = process.platform) {
  if (platform === "linux") {
    return execFileSync(
      "secret-tool",
      ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", "Grok Bot"],
      { encoding: "utf8" },
    ).trimEnd();
  }
  return execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
    { encoding: "utf8" },
  ).trimEnd();
}

export function loadGrokBotGatewaySession({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  getKeychainPassword = readKeychainPassword,
} = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) return null;

  const path = grokBotGatewayDescriptorPath(home, platform, env);
  if (!existsSync(path)) return null;

  const wrapped = JSON.parse(readFileSync(path, "utf8"));
  const encrypted = encryptedPayload(wrapped);
  const prefix = Buffer.from(encrypted, "base64").subarray(0, 3).toString("latin1");
  // Linux v10 is the keyring-less basic_text backend; no secret store to ask.
  const needsKeychain = !(platform === "linux" && prefix === SAFE_STORAGE_PREFIX_V10);
  const clear = decryptSafeStorageString(
    encrypted,
    needsKeychain ? getKeychainPassword(platform) : LINUX_BASIC_TEXT_PASSWORD,
    platform,
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
