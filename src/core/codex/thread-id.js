/**
 * Normalize Desktop sidebar thread ids for Codex app-server RPCs.
 *
 * ChatGPT Desktop sidebar rows use `local:<conversationId>`. App-server rejects
 * the prefixed form with `invalid thread id`. Temporary composer rows
 * (`local:client-new-thread:…`) have no app-server mapping.
 */

export const LOCAL_THREAD_ID_PREFIX = 'local:';
export const TEMP_THREAD_ID_PREFIX = 'local:client-new-thread:';

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isTemporaryDesktopThreadId(threadId) {
  return typeof threadId === 'string' && threadId.startsWith(TEMP_THREAD_ID_PREFIX);
}

/**
 * Strip a leading `local:` prefix. Temporary Desktop rows throw.
 * @param {string} threadId
 * @returns {string}
 */
export function normalizeCodexThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId) {
    throw new RangeError('Invalid threadId');
  }
  if (isTemporaryDesktopThreadId(threadId)) {
    throw new RangeError(
      'Temporary Desktop thread id ' + JSON.stringify(threadId)
        + ' has no app-server mapping; wait for the real conversation id',
    );
  }
  const bare = threadId.startsWith(LOCAL_THREAD_ID_PREFIX)
    ? threadId.slice(LOCAL_THREAD_ID_PREFIX.length)
    : threadId;
  if (!bare || !ID_PATTERN.test(bare)) {
    throw new RangeError('Invalid threadId');
  }
  return bare;
}

/** True when the value looks like a Desktop-prefixed durable id. */
export function hasLocalThreadPrefix(threadId) {
  return typeof threadId === 'string'
    && threadId.startsWith(LOCAL_THREAD_ID_PREFIX)
    && !isTemporaryDesktopThreadId(threadId);
}
