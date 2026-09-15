import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  outcomeFromError,
  outcomeFromReceipt,
  sendExitCode,
  statusExitCode,
  withStatusExitCode,
} from "../src/core/codex/contract.js";

describe("codex contract — status exit", () => {
  it("exit 0 only for reachable daemon", () => {
    assert.equal(statusExitCode({ reachable: true, mode: "daemon" }), 0);
    assert.equal(statusExitCode({ reachable: false, mode: "socket-absent" }), 1);
    assert.equal(statusExitCode({ reachable: true, mode: "bad-response" }), 1);
    assert.equal(statusExitCode({ reachable: false, mode: "daemon" }), 1);
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
    assert.equal(sendExitCode({ delivery: "accepted" }), 0);
    assert.equal(sendExitCode({ delivery: "queued" }), 0);
  });

  it("rejected, unknown, and error fail", () => {
    assert.equal(sendExitCode({ delivery: "rejected", error: "nope" }), 1);
    assert.equal(sendExitCode({ delivery: "unknown", error: "maybe" }), 1);
    assert.equal(sendExitCode({ delivery: "accepted", error: "x" }), 1);
  });

  it("approval-refused is accepted delivery with exit 1", () => {
    assert.equal(sendExitCode({ delivery: "accepted", reason: "approval-refused" }), 1);
  });
});

describe("codex contract — outcomeFromError", () => {
  it("flattens CodexSendError fields like fail()", () => {
    const err = Object.assign(new Error("busy thread"), {
      name: "CodexSendError",
      delivery: "rejected",
      reason: "busy",
      threadId: "thr_1",
      envelope: { messageId: "m_1", correlationId: "c_1", hop: 2 },
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

  it("keeps the bridge reason strings verbatim", () => {
    const reasons = ["busy", "hop-limit", "route-not-allowed", "thread-error", "unknown-status", "unknown-thread", "external-owner", "experimental-disabled", "unsupported", "rejected", "transport", "bad-response", "approval-refused", "usage"];
    for (const reason of reasons) {
      const out = outcomeFromError(
        Object.assign(new Error(reason), { delivery: "rejected", reason }),
      );
      assert.equal(out.reason, reason);
      assert.equal(out.exitCode, 1);
    }
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
    assert.ok(typeof out.error === "string" && out.error.length > 0);
  });
});
