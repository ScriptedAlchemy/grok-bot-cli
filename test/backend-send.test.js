import test from "node:test";
import assert from "node:assert/strict";

import { decodeFields, encodeSendRequest, refusalMessage } from "../src/core/backend-send.js";

test("encodes agent, nonce, prompt and desktop source", () => {
  const fields = decodeFields(encodeSendRequest({ agentId: "a1", prompt: "hi", clientNonce: "n1", sentAtMs: 5 }));
  assert.equal(new TextDecoder().decode(fields[1]), "a1");
  assert.equal(new TextDecoder().decode(fields[2]), "n1");
  assert.equal(new TextDecoder().decode(fields[3]), "hi");
  assert.equal(fields[4], 5);
  assert.equal(fields[13], 1);
});

test("a refused delivery is reported, an accepted one is not", () => {
  assert.equal(refusalMessage(Uint8Array.from([0x08, 1, 0x20, 2])), null);
  assert.equal(refusalMessage(Uint8Array.from([0x20, 4])), "refused");
});
