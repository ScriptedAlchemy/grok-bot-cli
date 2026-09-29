/**
 * ChatGPT Desktop DOM / data-layer for CDP Runtime.evaluate.
 *
 * ALL selector and in-page data extraction lives in this module. The adapter
 * and tools must not invent additional DOM selectors.
 *
 * Evidence (macOS ChatGPT.app / Codex Desktop, Electron, Chrome 154,
 * bundle com.openai.codex, v26.924.22138):
 * - Main window URL is exactly `app://-/index.html` (no query).
 * - Sidebar rows: `[role=button][data-app-action-sidebar-thread-row]` with
 *   `data-app-action-sidebar-thread-{id,title,pinned,selected,kind}`.
 * - Thread surface is the second `<main>` (`_MainContentSurface…`).
 * - Turns: `[data-turn-key]`; user bubbles: `[data-user-message-bubble]`.
 * - Timeline scroll: `[data-app-action-timeline-scroll]` (virtualized).
 * - send/waitForReply composer path is experimental (not fully explored).
 */

import type { ChatGptDesktopTarget, ChatGptDesktopThread, ChatGptDesktopTurn } from './types.js';
import type { CdpSession } from './cdp-session.js';

/** Exact main-window URL; ignore avatar-overlay, detached-window, webviews. */
export const MAIN_WINDOW_URL = 'app://-/index.html';

export const ATTR = {
  threadRow: 'data-app-action-sidebar-thread-row',
  threadId: 'data-app-action-sidebar-thread-id',
  threadTitle: 'data-app-action-sidebar-thread-title',
  threadPinned: 'data-app-action-sidebar-thread-pinned',
  threadSelected: 'data-app-action-sidebar-thread-selected',
  threadKind: 'data-app-action-sidebar-thread-kind',
  turnKey: 'data-turn-key',
  userBubble: 'data-user-message-bubble',
  timelineScroll: 'data-app-action-timeline-scroll',
  virtualizedTurn: 'data-virtualized-turn-content',
} as const;

export const SELECTORS = {
  threadRow: `[role="button"][${ATTR.threadRow}]`,
  turn: `[${ATTR.turnKey}]`,
  userBubble: `[${ATTR.userBubble}]`,
  timelineScroll: `[${ATTR.timelineScroll}]`,
  mainSurface: 'main',
  /**
   * Experimental composer candidates (send/waitForReply not fully explored).
   * Prefer a contenteditable / textarea inside the main surface.
   */
  composerCandidates: [
    'main [contenteditable="true"]',
    'main textarea',
    '[data-app-action-composer] [contenteditable="true"]',
    '[data-app-action-composer] textarea',
    'form [contenteditable="true"]',
    'form textarea',
  ],
  sendButtonCandidates: [
    'button[data-app-action-send]',
    'button[aria-label="Send"]',
    'button[aria-label="Send message"]',
    'main button[type="submit"]',
  ],
} as const;

export function isMainWindowTarget(target: {
  type?: string;
  url?: string;
}): boolean {
  return target.type === 'page' && target.url === MAIN_WINDOW_URL;
}

export function summarizeTargetInfos(
  targetInfos: readonly {
    targetId?: string;
    type?: string;
    title?: string;
    url?: string;
    attached?: boolean;
  }[],
): ChatGptDesktopTarget[] {
  return targetInfos
    .filter((t) => typeof t.targetId === 'string' && typeof t.type === 'string')
    .map((t) => ({
      targetId: String(t.targetId),
      type: String(t.type),
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
      attached: Boolean(t.attached),
    }));
}

export function pickMainWindowTarget(
  targets: readonly ChatGptDesktopTarget[],
): ChatGptDesktopTarget | null {
  return targets.find((t) => isMainWindowTarget(t)) ?? null;
}

/** In-page script: list sidebar threads from data attributes. */
export const LIST_THREADS_EXPRESSION = `(() => {
  const rows = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)}));
  return rows.map((row) => ({
    threadId: row.getAttribute(${JSON.stringify(ATTR.threadId)}) || '',
    title: row.getAttribute(${JSON.stringify(ATTR.threadTitle)}) || (row.textContent || '').trim(),
    pinned: row.getAttribute(${JSON.stringify(ATTR.threadPinned)}) === 'true',
    selected: row.getAttribute(${JSON.stringify(ATTR.threadSelected)}) === 'true',
    kind: row.getAttribute(${JSON.stringify(ATTR.threadKind)}) || 'unknown',
  })).filter((t) => t.threadId);
})()`;

/** In-page script: click a sidebar row by thread id (URL does not change). */
export function openThreadExpression(threadId: string): string {
  return `(() => {
    const id = ${JSON.stringify(threadId)};
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)}));
    const row = rows.find((el) => el.getAttribute(${JSON.stringify(ATTR.threadId)}) === id);
    if (!row) return { ok: false, error: 'thread-not-found' };
    row.click();
    return { ok: true, threadId: id };
  })()`;
}

/**
 * Scroll the virtualized timeline and collect turns keyed by data-turn-key.
 * User turns contain [data-user-message-bubble]; other turns are assistant/status.
 * Voice turns that only show "Worked for Xs" become status.
 */
export const READ_THREAD_EXPRESSION = `(() => {
  const scroll = document.querySelector(${JSON.stringify(SELECTORS.timelineScroll)});
  const mains = Array.from(document.querySelectorAll('main'));
  const surface = mains.length >= 2 ? mains[1] : (mains[0] || document.body);
  const root = scroll || surface;
  const collected = new Map();
  const statusRe = /^Worked for \\d+s$/i;
  const harvest = () => {
    for (const el of root.querySelectorAll(${JSON.stringify(SELECTORS.turn)})) {
      const turnKey = el.getAttribute(${JSON.stringify(ATTR.turnKey)}) || '';
      if (!turnKey || collected.has(turnKey)) continue;
      const user = el.querySelector(${JSON.stringify(SELECTORS.userBubble)});
      const text = (el.innerText || '').trim();
      let role = 'assistant';
      if (user) role = 'user';
      else if (!text || statusRe.test(text)) role = 'status';
      collected.set(turnKey, { turnKey, role, text });
    }
  };
  const maxPasses = 80;
  let stable = 0;
  let lastSize = -1;
  if (scroll) scroll.scrollTop = 0;
  for (let i = 0; i < maxPasses; i++) {
    harvest();
    if (collected.size === lastSize) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
      lastSize = collected.size;
    }
    if (scroll) {
      const next = Math.min(scroll.scrollHeight, scroll.scrollTop + Math.max(scroll.clientHeight, 200));
      if (next <= scroll.scrollTop && stable >= 1) break;
      scroll.scrollTop = next;
    } else {
      break;
    }
  }
  harvest();
  return Array.from(collected.values());
})()`;

/** Experimental: insert text into the composer and submit (Enter / send button). */
export function sendMessageExpression(text: string): string {
  const composers = JSON.stringify([...SELECTORS.composerCandidates]);
  const buttons = JSON.stringify([...SELECTORS.sendButtonCandidates]);
  return `(() => {
    const text = ${JSON.stringify(text)};
    const composers = ${composers};
    let composer = null;
    for (const sel of composers) {
      composer = document.querySelector(sel);
      if (composer) break;
    }
    if (!composer) return { ok: false, error: 'composer-not-found' };
    composer.focus();
    if (composer.isContentEditable) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    } else if ('value' in composer) {
      composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      return { ok: false, error: 'composer-unsupported' };
    }
    const buttons = ${buttons};
    let sent = false;
    for (const sel of buttons) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) { btn.click(); sent = true; break; }
    }
    if (!sent) {
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
    return { ok: true, sentVia: sent ? 'button' : 'enter' };
  })()`;
}

export async function listThreadsFromDom(
  session: CdpSession,
  sessionId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<ChatGptDesktopThread[]> {
  const rows = await session.evaluate<ChatGptDesktopThread[]>(LIST_THREADS_EXPRESSION, { sessionId });
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, limit).map((row) => ({
    threadId: String(row.threadId),
    title: String(row.title ?? ''),
    pinned: Boolean(row.pinned),
    selected: Boolean(row.selected),
    kind: String(row.kind ?? 'unknown'),
  }));
}

export async function openThreadInDom(
  session: CdpSession,
  sessionId: string,
  threadId: string,
): Promise<void> {
  const result = await session.evaluate<{ ok: boolean; error?: string }>(
    openThreadExpression(threadId),
    { sessionId },
  );
  if (!result?.ok) {
    throw new Error(result?.error === 'thread-not-found'
      ? `ChatGPT Desktop thread not found: ${threadId}`
      : `Failed to open ChatGPT Desktop thread ${threadId}`);
  }
}

export async function readTurnsFromDom(
  session: CdpSession,
  sessionId: string,
  { limit = 100 }: { limit?: number } = {},
): Promise<ChatGptDesktopTurn[]> {
  const turns = await session.evaluate<ChatGptDesktopTurn[]>(READ_THREAD_EXPRESSION, { sessionId });
  if (!Array.isArray(turns)) return [];
  return turns.slice(-limit).map((turn) => ({
    turnKey: String(turn.turnKey),
    role: turn.role === 'user' || turn.role === 'status' ? turn.role : 'assistant',
    text: String(turn.text ?? ''),
  }));
}

export async function sendMessageInDom(
  session: CdpSession,
  sessionId: string,
  text: string,
): Promise<{ sentVia: string }> {
  // Prefer CDP Input.insertText when focused; fall back to DOM script.
  try {
    await session.send('Input.insertText', { text }, { sessionId });
  } catch {
    // Composer may not be focused yet; the evaluate path focuses + fills.
  }
  const result = await session.evaluate<{ ok: boolean; error?: string; sentVia?: string }>(
    sendMessageExpression(text),
    { sessionId },
  );
  if (!result?.ok) {
    throw new Error(
      result?.error === 'composer-not-found'
        ? 'ChatGPT Desktop composer not found (experimental send path)'
        : `ChatGPT Desktop send failed: ${result?.error ?? 'unknown'}`,
    );
  }
  return { sentVia: result.sentVia ?? 'unknown' };
}
