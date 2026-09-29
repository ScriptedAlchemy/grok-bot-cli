/**
 * Desktop sidebar thread ids ↔ Codex app-server thread ids.
 *
 * ChatGPT Desktop sidebar rows use `data-app-action-sidebar-thread-id` values
 * shaped like `local:<conversationId>`. App-server APIs use the bare
 * `<conversationId>` only — the `local:` form fails with `invalid thread id`.
 *
 * Temporary composer rows (`local:client-new-thread:…`) are CDP-only until the
 * first reply annotates a real conversation id — they do not map to app-server.
 */

import {
  LOCAL_THREAD_ID_PREFIX as SHARED_LOCAL_PREFIX,
  TEMP_THREAD_ID_PREFIX as SHARED_TEMP_PREFIX,
  isTemporaryDesktopThreadId as sharedIsTemporary,
  normalizeCodexThreadId,
} from '../codex/thread-id.js';
import { TEMP_THREAD_ID_PREFIX as CDP_TEMP_PREFIX } from './cdp-dom.js';

export const LOCAL_THREAD_ID_PREFIX = SHARED_LOCAL_PREFIX;
export const TEMP_THREAD_ID_PREFIX = CDP_TEMP_PREFIX;

/** DOM `data-turn-key` prefix; app-server turn ids are the trailing segment. */
export const HISTORY_CONTENT_TURN_PREFIX = 'history-content:turn:' as const;

/** True when the id is a transient sidebar row, not a durable conversation. */
export function isTemporaryDesktopThreadId(threadId: string): boolean {
  return sharedIsTemporary(threadId) || threadId.startsWith(SHARED_TEMP_PREFIX);
}

/**
 * Map a Desktop sidebar id (or bare id) to the app-server thread id.
 * Returns null when the id is temporary or empty (no app-server mapping).
 */
export function toAppServerThreadId(threadId: string): string | null {
  if (!threadId || isTemporaryDesktopThreadId(threadId)) return null;
  try {
    return normalizeCodexThreadId(threadId);
  } catch {
    return null;
  }
}

/** Require a bare app-server id; throws when the input cannot be mapped. */
export function requireAppServerThreadId(threadId: string): string {
  const bare = toAppServerThreadId(threadId);
  if (!bare) {
    throw new Error(
      `No app-server thread id mapping for ${JSON.stringify(threadId)} ` +
        `(temporary Desktop rows need CDP; strip a leading "local:" for durable ids)`,
    );
  }
  return bare;
}

/** Present an app-server (or bare) id in Desktop sidebar form. */
export function toDesktopThreadId(threadId: string): string {
  if (!threadId || isTemporaryDesktopThreadId(threadId)) return threadId;
  if (threadId.startsWith(LOCAL_THREAD_ID_PREFIX)) return threadId;
  return `${LOCAL_THREAD_ID_PREFIX}${threadId}`;
}

/** Compare Desktop and app-server id forms as the same conversation. */
export function threadIdsEquivalent(a: string, b: string): boolean {
  const left = toAppServerThreadId(a) ?? a;
  const right = toAppServerThreadId(b) ?? b;
  return left === right;
}

/** Format an app-server turn id as the DOM `data-turn-key` value. */
export function toDomTurnKey(turnId: string): string {
  if (!turnId) return turnId;
  if (turnId.startsWith(HISTORY_CONTENT_TURN_PREFIX)) return turnId;
  return `${HISTORY_CONTENT_TURN_PREFIX}${turnId}`;
}

/**
 * @deprecated Prefer requireAppServerThreadId — the `local:` form is rejected
 * by app-server (`invalid thread id`). Kept for callers that want a list.
 */
export function appServerThreadIdCandidates(threadId: string): string[] {
  const bare = toAppServerThreadId(threadId);
  return bare ? [bare] : [];
}
