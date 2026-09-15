import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAllowedCredentialUrl,
  redactSecrets,
  resetPolicyWarnings,
} from "../src/url-policy.js";

function withEnv(values, fn) {
  const prev = {};
  for (const key of Object.keys(values)) {
    prev[key] = process.env[key];
    const v = values[key];
    if (v == null) delete process.env[key];
    else process.env[key] = v;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("allows https cursor.sh gateway hosts", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: null, GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://api2.cursor.sh"),
      "https://api2.cursor.sh",
    );
    assert.equal(
      assertAllowedCredentialUrl("https://box-abc.cursor.sh/"),
      "https://box-abc.cursor.sh",
    );
    assert.equal(
      assertAllowedCredentialUrl("https://agent.cursor.com"),
      "https://agent.cursor.com",
    );
    // The box gateway EnsureSandBox hands out lives on this family.
    assert.equal(
      assertAllowedCredentialUrl("https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com/"),
      "https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com",
    );
    assert.throws(() => assertAllowedCredentialUrl("https://cursorvm.com.evil.example"), /Rejected gateway URL host/i);
  });
});

test("backend URLs reject cursorvm and loopback", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: "1", GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://api2.cursor.sh", { kind: "backend" }),
      "https://api2.cursor.sh",
    );
    assert.throws(
      () =>
        assertAllowedCredentialUrl("https://145d7c6d03c7434e75f0-pod-abc-1340.us12.cursorvm.com", {
          kind: "backend",
        }),
      /Rejected backend URL host/i,
    );
    assert.throws(
      () => assertAllowedCredentialUrl("http://127.0.0.1:1340", { kind: "backend" }),
      /EnsureSandBox backends must be https/i,
    );
  });
});

test("rejects http and non-cursor hosts by default", () => {
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: null, GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.throws(() => assertAllowedCredentialUrl("http://api2.cursor.sh"), /only https/i);
    assert.throws(() => assertAllowedCredentialUrl("https://evil.example"), /Rejected gateway URL host/i);
    assert.throws(() => assertAllowedCredentialUrl("https://127.0.0.1:1340"), /GROK_BOT_ALLOW_LOCAL_GATEWAY/i);
    assert.throws(() => assertAllowedCredentialUrl("https://0.0.0.0:1340"), /Rejected gateway URL host/i);
  });
});

test("allows local gateways when opted in", () => {
  resetPolicyWarnings();
  withEnv({ GROK_BOT_ALLOW_LOCAL_GATEWAY: "1", GROK_BOT_ALLOW_ANY_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("http://127.0.0.1:1340"),
      "http://127.0.0.1:1340",
    );
    assert.equal(
      assertAllowedCredentialUrl("http://localhost:1340/"),
      "http://localhost:1340",
    );
  });
});

test("ALLOW_ANY_GATEWAY bypasses host checks", () => {
  resetPolicyWarnings();
  withEnv({ GROK_BOT_ALLOW_ANY_GATEWAY: "true", GROK_BOT_ALLOW_LOCAL_GATEWAY: null }, () => {
    assert.equal(
      assertAllowedCredentialUrl("https://evil.example/path"),
      "https://evil.example/path",
    );
  });
});

test("redacts bearer, basic, cookie, and token-like fields", () => {
  const out = redactSecrets(
    'EnsureSandBox failed: 401 {"gatewayToken":"supersecret","x-anyrun-network-token":"route"} ' +
      "Bearer abc.def-ghi+= authorization: Basic YWJjMTIz Cookie: sid=keepsecret Set-Cookie: a=b",
  );
  assert.match(out, /Bearer <redacted>/);
  assert.match(out, /gatewayToken":"<redacted>/);
  assert.match(out, /authorization: <redacted>/i);
  assert.match(out, /Cookie: <redacted>/i);
  assert.match(out, /Set-Cookie: <redacted>/i);
  assert.doesNotMatch(out, /supersecret/);
  assert.doesNotMatch(out, /abc\.def-ghi/);
  assert.doesNotMatch(out, /YWJjMTIz/);
  assert.doesNotMatch(out, /keepsecret/);
});
