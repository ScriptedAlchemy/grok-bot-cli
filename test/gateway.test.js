import test from "node:test";
import assert from "node:assert/strict";
import {
  headersFromEnsureSandbox,
  mergeGatewayHeaders,
  parseGatewayHeaders,
  requestHeaders,
} from "../src/headers.js";

test("parses env JSON headers", () => {
  const headers = parseGatewayHeaders('{"X-Anyrun-Network-Token":"abc","empty":""}');
  assert.deepEqual(headers, { "x-anyrun-network-token": "abc" });
});

test("reads EnsureSandBox gatewayHeaders", () => {
  const headers = headersFromEnsureSandbox({
    gatewayHeaders: { "X-Anyrun-Network-Token": "from-ensure" },
  });
  assert.equal(headers["x-anyrun-network-token"], "from-ensure");
});

test("reads EnsureSandBox token field", () => {
  const headers = headersFromEnsureSandbox({ anyrunNetworkToken: "field-token" });
  assert.equal(headers["x-anyrun-network-token"], "field-token");
});

test("env headers override EnsureSandBox", () => {
  const headers = mergeGatewayHeaders(
    { "x-anyrun-network-token": "ensure" },
    { "x-anyrun-network-token": "env" },
  );
  assert.equal(headers["x-anyrun-network-token"], "env");
});

test("request headers keep routing header", () => {
  const headers = requestHeaders({
    gatewayToken: "gw",
    gatewayHeaders: { "x-anyrun-network-token": "route" },
  });
  assert.equal(headers["x-anyrun-network-token"], "route");
  assert.match(headers.authorization, /^Bearer /);
});

test("empty env JSON is a no-op", () => {
  assert.deepEqual(parseGatewayHeaders(""), {});
  assert.deepEqual(parseGatewayHeaders(undefined), {});
});
