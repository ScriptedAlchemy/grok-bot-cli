/**
 * #46 Codex contract documents and exit-code derivation.
 * The bridge and the CLI routes flatten through these helpers so reason/delivery
 * spelling stays one owner. No process I/O here.
 */

import { redactSecrets } from "../url-policy.js";

/** @typedef {'accepted' | 'queued' | 'rejected' | 'unknown'} CodexDelivery */
/**
 * @typedef {{
 *   delivery: CodexDelivery,
 *   exitCode: 0 | 1,
 *   error?: string,
 *   reason?: string,
 *   mode?: string,
 *   threadId?: string,
 *   turnId?: string,
 *   turnStatus?: string,
 *   queuedSubmissionId?: string,
 *   refused?: string[],
 *   messageId?: string,
 *   correlationId?: string,
 *   hop?: number,
 *   replyTo?: string,
 *   threadStatus?: string,
 *   model?: string,
 *   cwd?: string,
 *   approvalPolicy?: string,
 *   maxHops?: number,
 * }} CodexSendOutcome
 */

/**
 * Exit 0 iff the daemon is usable.
 * @param {{ reachable: boolean, mode: string }} status
 * @returns {0 | 1}
 */
function statusExitCode(status) {
  return status.reachable && status.mode === "daemon" ? 0 : 1;
}

/**
 * Attach derived exitCode to a status document (never mutates input).
 * @param {Record<string, unknown>} status
 */
export function withStatusExitCode(status) {
  return {
    ...status,
    exitCode: statusExitCode(/** @type {{ reachable: boolean, mode: string }} */ (status)),
  };
}

/**
 * @param {{
 *   delivery: CodexDelivery,
 *   reason?: string,
 *   error?: string,
 * }} outcome
 * @returns {0 | 1}
 */
function sendExitCode(outcome) {
  if (outcome.error !== undefined) return 1;
  if (outcome.delivery === "accepted" && outcome.reason === "approval-refused") return 1;
  if (outcome.delivery === "rejected" || outcome.delivery === "unknown") return 1;
  return 0;
}

/**
 * Flatten a thrown error into the #46 send/failure document (plus exitCode).
 *
 * @param {unknown} error
 * @param {{ isUsage?: (err: unknown) => boolean }} [opts]
 * @returns {CodexSendOutcome & { error: string, exitCode: 1 }}
 */
export function outcomeFromError(error, opts = {}) {
  const isUsage = opts.isUsage ?? ((err) =>
    err instanceof RangeError || Boolean(err && typeof err === "object" && err.name === "StoreError"));
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  /** @type {Record<string, unknown>} */
  const out = { error: message };

  if (error && typeof error === "object") {
    for (const key of ["delivery", "reason", "mode", "threadId", "turnId", "targetId", "messageId", "correlationId", "refused", "hop"]) {
      if (error[key] !== undefined) out[key] = error[key];
    }
    if (out.reason === undefined && isUsage(error)) out.reason = "usage";
  }

  if (out.delivery === undefined) out.delivery = "rejected";
  return /** @type {CodexSendOutcome & { error: string, exitCode: 1 }} */ ({ ...out, exitCode: 1 });
}

/**
 * Normalize a successful send receipt into a document with exitCode.
 * @param {Record<string, unknown>} receipt
 * @returns {CodexSendOutcome}
 */
export function outcomeFromReceipt(receipt) {
  const base = { ...receipt };
  if (base.delivery === undefined) base.delivery = "accepted";
  const exitCode = sendExitCode(/** @type {{ delivery: CodexDelivery, reason?: string, error?: string }} */ (base));
  if (exitCode === 1 && base.error === undefined && base.reason === "approval-refused") {
    base.error = typeof base.message === "string" ? base.message : "Codex refused one or more approvals.";
  }
  return /** @type {CodexSendOutcome} */ ({ ...base, exitCode });
}
