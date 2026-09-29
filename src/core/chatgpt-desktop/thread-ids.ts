/**
 * Desktop sidebar thread ids ↔ Codex app-server thread ids.
 *
 * ChatGPT Desktop sidebar rows use `data-app-action-sidebar-thread-id` values
 * shaped like `local:<conversationId>`. The Codex app-server `thread/list`,
 * `thread/read`, and `thread/resume` APIs use the bare `<conversationId>`.
 *
 * Temporary composer rows (`local:client-new-thread:…`) are CDP-only until the
 * first reply annotates a real conversation id — they do not map to app-server.
 */

import { TEMP_THREAD_ID_PREFIX } from './cdp-dom.js';

export const LOCAL_THREAD_ID_PREFIX = 'local:' as const;

/** True when the id is a transient sidebar row, not a durable conversation. */
export function isTemporaryDesktopThreadId(threadId: string): boolean {
  return threadId.startsWith(TEMP_THREAD_ID_PREFIX);
}

/**
 * Map a Desktop sidebar id to the app-server thread id.
 * Returns null when the id is temporary or empty (no app-server mapping).
 */
export function toAppServerThreadId(threadId: string): string | null {
  if (!threadId || isTemporaryDesktopThreadId(threadId)) return null;
  if (threadId.startsWith(LOCAL_THREAD_ID_PREFIX)) {
    const bare = threadId.slice(LOCAL_THREAD_ID_PREFIX.length);
    return bare || null;
  }
  return threadId;
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

/**
 * Ordered candidates to try against app-server. Prefer the bare conversation
 * id; also try the original and `local:` form so mapping can be verified.
 */
export function appServerThreadIdCandidates(threadId: string): string[] {
  if (!threadId || isTemporaryDesktopThreadId(threadId)) return [];
  const bare = toAppServerThreadId(threadId);
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  push(bare);
  push(threadId);
  if (bare) push(toDesktopThreadId(bare));
  return out;
}
