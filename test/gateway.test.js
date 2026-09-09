import test from "node:test";
import assert from "node:assert/strict";
import {
  headersFromEnsureSandbox,
  mergeGatewayHeaders,
  parseGatewayHeaders,
  requestHeaders,
} from "../src/headers.js";
import {
  DEFAULT_GATEWAY_TIMEOUT_MS,
  ensureSandbox,
  gatewayCall,
} from "../src/gateway.js";

function response({ ok = true, status = 200, body = "{}", statusText = "" } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

const session = {
  gatewayUrl: "https://gateway.invalid",
  gatewayToken: "test-token",
};

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

test("gateway requests use a finite default deadline", () => {
  assert.equal(DEFAULT_GATEWAY_TIMEOUT_MS, 15_000);
});

test("gateway timeout aborts one fetch without retrying", async () => {
  let calls = 0;
  let signal;
  const fetchImpl = async (url, init) => {
    calls += 1;
    signal = init.signal;
    return new Promise(() => {});
  };

  await assert.rejects(
    gatewayCall(session, "listAgents", {}, { timeoutMs: 10, fetchImpl }),
    (error) => {
      assert.equal(error.name, "GatewayError");
      assert.equal(error.code, "GATEWAY_TIMEOUT");
      assert.equal(error.method, "listAgents");
      assert.match(error.message, /^listAgents timed out after 10ms\.$/);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("gateway deadline also bounds response body reads", async () => {
  let calls = 0;
  let signal;
  const fetchImpl = async (url, init) => {
    calls += 1;
    signal = init.signal;
    return {
      ...response(),
      text: async () => new Promise(() => {}),
    };
  };

  await assert.rejects(
    gatewayCall(session, "getAgentThread", {}, { timeoutMs: 10, fetchImpl }),
    (error) => error.code === "GATEWAY_TIMEOUT" && error.method === "getAgentThread",
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("send timeout reports unknown effect and is never retried", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Promise(() => {});
  };

  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, { timeoutMs: 10, fetchImpl }),
    (error) => {
      assert.equal(error.code, "GATEWAY_TIMEOUT");
      assert.equal(error.effect, "unknown");
      assert.equal(error.message, "sendPrompt timed out after 10ms; delivery is unknown. Do not resend automatically.");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("ensureSandbox has the same controllable deadline", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Promise(() => {});
  };

  await assert.rejects(
    ensureSandbox("access-token", { timeoutMs: 10, fetchImpl }),
    (error) => error.code === "GATEWAY_TIMEOUT" && error.method === "EnsureSandBox",
  );
  assert.equal(calls, 1);
});

test("invalid deadlines fail before fetch", async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    let calls = 0;
    await assert.rejects(
      gatewayCall(session, "listAgents", {}, {
        timeoutMs,
        fetchImpl: async () => {
          calls += 1;
          return response();
        },
      }),
      (error) => error.code === "INVALID_GATEWAY_TIMEOUT",
    );
    assert.equal(calls, 0);
  }
});

test("HTTP errors do not expose response body or status text", async () => {
  const secret = "raw-private-message token-123";
  await assert.rejects(
    gatewayCall(session, "getAgentThread", {}, {
      fetchImpl: async () => response({
        ok: false,
        status: 403,
        statusText: "Bearer status-secret",
        body: JSON.stringify({ error: secret }),
      }),
    }),
    (error) => {
      assert.equal(error.message, "getAgentThread failed with HTTP 403.");
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /private|token|Bearer|status-secret/);
      return true;
    },
  );
});

test("EnsureSandBox HTTP errors do not expose response details", async () => {
  await assert.rejects(
    ensureSandbox("access-token", {
      fetchImpl: async () => response({
        ok: false,
        status: 401,
        statusText: "Bearer status-secret",
        body: '{"error":"raw token=secret"}',
      }),
    }),
    (error) => {
      assert.equal(error.message, "EnsureSandBox failed with HTTP 401.");
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /raw|token|Bearer|secret/);
      return true;
    },
  );
});

test("network errors do not expose socket details or URLs", async () => {
  const secret = "connect ECONNREFUSED https://gateway.invalid/?token=secret";
  await assert.rejects(
    gatewayCall(session, "listAgents", {}, {
      fetchImpl: async () => { throw new Error(secret); },
    }),
    (error) => {
      assert.equal(error.message, "listAgents request failed.");
      assert.equal(error.code, "GATEWAY_REQUEST_FAILED");
      assert.doesNotMatch(error.message, /ECONNREFUSED|gateway|token|secret/);
      return true;
    },
  );
});

test("send network errors report unknown effect without leaking details", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => { throw new Error("socket failed with token=secret"); },
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_REQUEST_FAILED");
      assert.equal(error.effect, "unknown");
      assert.equal(error.message, "sendPrompt request failed; delivery is unknown. Do not resend automatically.");
      assert.doesNotMatch(error.message, /socket|token|secret/);
      return true;
    },
  );
});

test("successful non-JSON responses fail safely without exposing body", async () => {
  const raw = "private transcript and token=secret";
  await assert.rejects(
    gatewayCall(session, "getAgentThread", {}, {
      fetchImpl: async () => response({ body: raw }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.message, "getAgentThread returned an invalid response.");
      assert.doesNotMatch(error.message, /private|token|secret/);
      return true;
    },
  );
});

test("send non-JSON success reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "not-json" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      assert.equal(error.message, "sendPrompt returned an invalid response; delivery is unknown. Do not resend automatically.");
      return true;
    },
  );
});

test("ambiguous send HTTP failures report unknown effect without retry", async () => {
  for (const status of [408, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
        fetchImpl: async () => {
          calls += 1;
          return response({
            ok: false,
            status,
            body: '{"error":"private token=secret"}',
          });
        },
      }),
      (error) => {
        assert.equal(error.effect, "unknown");
        assert.equal(error.message, "sendPrompt failed with HTTP " + status + "; delivery is unknown. Do not resend automatically.");
        assert.doesNotMatch(error.message, /private|token|secret/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("empty send success reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      assert.equal(error.message, "sendPrompt returned an invalid response; delivery is unknown. Do not resend automatically.");
      return true;
    },
  );
});

test("empty successful bodies preserve the existing empty object result", async () => {
  assert.deepEqual(await gatewayCall(session, "deleteAgent", {}, {
    fetchImpl: async () => response({ body: "" }),
  }), {});
});

test("gateway fetch rejects redirects while preserving a normal HTTPS request", async () => {
  let observed;
  const data = await gatewayCall(session, "listAgents", {}, {
    fetchImpl: async (url, init) => {
      observed = { url, redirect: init.redirect, method: init.method };
      return response({ body: '{"agents":[]}' });
    },
  });

  assert.deepEqual(data, { agents: [] });
  assert.deepEqual(observed, {
    url: "https://gateway.invalid/api/listAgents",
    redirect: "error",
    method: "POST",
  });
});

test("HTTP error with stalled body reports HTTP status, not timeout", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      timeoutMs: 50,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        statusText: "",
        text: async () => new Promise(() => {}),
      }),
    }),
    (error) => {
      assert.equal(error.message, "sendPrompt failed with HTTP 400.");
      assert.equal(error.status, 400);
      assert.equal(error.effect, undefined);
      assert.notEqual(error.code, "GATEWAY_TIMEOUT");
      return true;
    },
  );
});

test("5xx error with stalled body reports HTTP status with unknown effect, not timeout", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      timeoutMs: 50,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "",
        text: async () => new Promise(() => {}),
      }),
    }),
    (error) => {
      assert.equal(error.message, "sendPrompt failed with HTTP 503; delivery is unknown. Do not resend automatically.");
      assert.equal(error.status, 503);
      assert.equal(error.effect, "unknown");
      assert.notEqual(error.code, "GATEWAY_TIMEOUT");
      return true;
    },
  );
});

test("null JSON send response reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "null" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      assert.equal(error.message, "sendPrompt returned an invalid response; delivery is unknown. Do not resend automatically.");
      return true;
    },
  );
});

test("null JSON for non-send methods returns null data as-is", async () => {
  const result = await gatewayCall(session, "deleteAgent", {}, {
    fetchImpl: async () => response({ body: "null" }),
  });
  assert.equal(result, null);
});

test("false JSON send response reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "false" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      return true;
    },
  );
});

test("false JSON for non-send methods returns false data as-is", async () => {
  const result = await gatewayCall(session, "deleteAgent", {}, {
    fetchImpl: async () => response({ body: "false" }),
  });
  assert.equal(result, false);
});

test("HTTP error aborts controller to release the socket", async () => {
  let signal;
  await assert.rejects(
    gatewayCall(session, "listAgents", {}, {
      fetchImpl: async (url, init) => {
        signal = init.signal;
        return response({ ok: false, status: 500 });
      },
    }),
    (error) => error.status === 500,
  );
  assert.equal(signal.aborted, true);
});

test("non-object send responses (0, empty string) report unknown effect", async () => {
  for (const body of ["0", '""']) {
    await assert.rejects(
      gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
        fetchImpl: async () => response({ body }),
      }),
      (error) => {
        assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
        assert.equal(error.effect, "unknown");
        return true;
      },
    );
  }
});

test("non-object values for non-send methods pass through as-is", async () => {
  for (const [body, expected] of [["0", 0], ['""', ""]]) {
    const result = await gatewayCall(session, "deleteAgent", {}, {
      fetchImpl: async () => response({ body }),
    });
    assert.equal(result, expected);
  }
});

test("array send response reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "[]" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      return true;
    },
  );
});

test("empty-object send response reports unknown effect", async () => {
  await assert.rejects(
    gatewayCall(session, "sendPrompt", { prompt: "hello" }, {
      fetchImpl: async () => response({ body: "{}" }),
    }),
    (error) => {
      assert.equal(error.code, "GATEWAY_INVALID_RESPONSE");
      assert.equal(error.effect, "unknown");
      return true;
    },
  );
});
