import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  outcomeFromError,
  outcomeFromReceipt,
  withStatusExitCode,
} from "../src/core/codex/contract.js";

describe("codex contract — status exit", () => {
  it("exit 0 only for reachable daemon", () => {
    assert.equal(withStatusExitCode({ reachable: true, mode: "daemon" }).exitCode, 0);
    assert.equal(withStatusExitCode({ reachable: false, mode: "socket-absent" }).exitCode, 1);
    assert.equal(withStatusExitCode({ reachable: true, mode: "bad-response" }).exitCode, 1);
    assert.equal(withStatusExitCode({ reachable: false, mode: "daemon" }).exitCode, 1);
  });

  it("withStatusExitCode attaches exitCode without mutating", () => {
    const status = { reachable: true, mode: "daemon", socketPath: "/tmp/x" };
    const doc = withStatusExitCode(status);
    assert.equal(doc.exitCode, 0);
    assert.equal("exitCode" in status, false);
  });
});

describe("codex contract — send exit", () => {
  it("accepted and queued succeed", () => {
    assert.equal(outcomeFromReceipt({ delivery: "accepted" }).exitCode, 0);
    assert.equal(outcomeFromReceipt({ delivery: "queued" }).exitCode, 0);
  });

  it("rejected, unknown, and error fail", () => {
    assert.equal(outcomeFromReceipt({ delivery: "rejected", error: "nope" }).exitCode, 1);
    assert.equal(outcomeFromReceipt({ delivery: "unknown", error: "maybe" }).exitCode, 1);
    assert.equal(outcomeFromReceipt({ delivery: "accepted", error: "x" }).exitCode, 1);
  });

  it("approval-refused is accepted delivery with exit 1", () => {
    assert.equal(outcomeFromReceipt({ delivery: "accepted", reason: "approval-refused" }).exitCode, 1);
  });
});

describe("codex contract — outcomeFromError", () => {
  it("flattens CodexSendError fields like fail()", () => {
    const err = Object.assign(new Error("busy thread"), {
      name: "CodexSendError",
      delivery: "rejected",
      reason: "busy",
      threadId: "thr_1",
      messageId: "m_1",
      correlationId: "c_1",
      hop: 2,
    });
    const out = outcomeFromError(err);
    assert.equal(out.error, "busy thread");
    assert.equal(out.delivery, "rejected");
    assert.equal(out.reason, "busy");
    assert.equal(out.threadId, "thr_1");
    assert.equal(out.messageId, "m_1");
    assert.equal(out.correlationId, "c_1");
    assert.equal(out.hop, 2);
    assert.equal(out.exitCode, 1);
  });

  it("marks StoreError as usage", () => {
    const err = Object.assign(new Error("bad argv"), { name: "StoreError" });
    const out = outcomeFromError(err);
    assert.equal(out.reason, "usage");
    assert.equal(out.delivery, "rejected");
    assert.equal(out.exitCode, 1);
  });

  it("marks route input errors as usage", () => {
    const out = outcomeFromError(new RangeError("bad flag"));
    assert.equal(out.reason, "usage");
    assert.equal(out.delivery, "rejected");
    assert.equal(out.exitCode, 1);
  });
});

describe("codex contract — outcomeFromReceipt", () => {
  it("queued receipt exits 0", () => {
    const out = outcomeFromReceipt({
      delivery: "queued",
      threadId: "t",
      messageId: "m",
      queuedSubmissionId: "q",
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.error, undefined);
  });

  it("approval-refused receipt exits 1 with error", () => {
    const out = outcomeFromReceipt({
      delivery: "accepted",
      reason: "approval-refused",
      threadId: "t",
      turnId: "turn",
      refused: ["approvals/request"],
    });
    assert.equal(out.exitCode, 1);
    assert.equal(out.error, "Codex refused one or more approvals.");
  });
});
