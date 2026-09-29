/**
 * ChatGPT Desktop DOM / data-layer for CDP Runtime.evaluate.
 *
 * ALL selector and in-page data extraction lives in this module. The adapter
 * and tools must not invent additional DOM selectors.
 *
 * Evidence (macOS ChatGPT.app, bundle id com.openai.codex, v26.924.22138,
 * Electron with renamed `Codex Framework.framework`, Chrome 154):
 * - Launch with `--remote-debugging-port` (fuses block Node inspect / RunAsNode
 *   but not this Chromium flag). Port binds to 127.0.0.1. Do not use
 *   `@electron/fuses read` (fails on the renamed framework).
 * - Prefer CDP `Target.getTargets` (`/json/list` is incomplete + order-unstable).
 * - Main window: type `page`, url exactly `app://-/index.html` (no query).
 *   Ignore avatar-overlay, detached-window, and chatgpt.com / codex-sandbox webviews.
 * - Sidebar rows: `[role=button][data-app-action-sidebar-thread-row]` with
 *   `data-app-action-sidebar-thread-{id,title,pinned,selected,kind}` (ids like
 *   `local:<uuid>`; kind seen: local). Rows are not links — click to open; URL
 *   does not change.
 * - Thread surface: second `<main>` whose class starts with `_MainContentSurface`.
 * - Turns: `[data-turn-key]`; user bubbles: `[data-user-message-bubble]`;
 *   timeline scroll: `[data-app-action-timeline-scroll]` (virtualized via
 *   `data-virtualized-turn-content`). Scroll top→bottom until turn keys stabilize.
 *   Voice turns that only show "Worked for Xs" → role `status`.
 * - send/waitForReply: not fully explored — experimental composer constants below.
 */

import type { ChatGptDesktopTarget, ChatGptDesktopThread, ChatGptDesktopTurn } from './types.js';
import type { CdpSession } from './cdp-session.js';

/** Exact main-window URL; ignore everything else. */
export const MAIN_WINDOW_URL = 'app://-/index.html';

/**
 * URL fragments that must never be treated as the main ChatGPT window.
 * Selection still uses exact `MAIN_WINDOW_URL` equality; these document rejects.
 */
export const IGNORED_TARGET_URL_MARKERS = [
  'initialRoute=%2Favatar-overlay',
  'detached-window.html',
  'chatgpt.com',
  'codex-sandbox',
] as const;

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

/** Class-name prefix on the thread's `<main>` (second main in the document). */
export const MAIN_CONTENT_SURFACE_CLASS_PREFIX = '_MainContentSurface';

/**
 * Experimental composer selectors (send/waitForReply not explored on-device yet).
 * Prefer a contenteditable / textarea inside the main surface.
 */
export const COMPOSER_SELECTORS = [
  'main [contenteditable="true"]',
  'main textarea',
  '[data-app-action-composer] [contenteditable="true"]',
  '[data-app-action-composer] textarea',
  'form [contenteditable="true"]',
  'form textarea',
] as const;

/** Experimental send-button selectors used after Input.insertText. */
export const SEND_BUTTON_SELECTORS = [
  'button[data-app-action-send]',
  'button[aria-label="Send"]',
  'button[aria-label="Send message"]',
  'main button[type="submit"]',
] as const;

export const SELECTORS = {
  threadRow: `[role="button"][${ATTR.threadRow}]`,
  turn: `[${ATTR.turnKey}]`,
  userBubble: `[${ATTR.userBubble}]`,
  timelineScroll: `[${ATTR.timelineScroll}]`,
  mainSurface: 'main',
  composerCandidates: COMPOSER_SELECTORS,
  sendButtonCandidates: SEND_BUTTON_SELECTORS,
} as const;

export function isMainWindowTarget(target: {
  type?: string;
  url?: string;
}): boolean {
  if (target.type !== 'page') return false;
  const url = typeof target.url === 'string' ? target.url : '';
  if (url !== MAIN_WINDOW_URL) return false;
  // Exact match already excludes query overlays / detached / webviews; markers
  // are a belt-and-suspenders guard if a caller passes a looser URL later.
  return !IGNORED_TARGET_URL_MARKERS.some((marker) => url.includes(marker));
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
 * Prefer the second `<main>` whose class starts with `_MainContentSurface`.
 * User turns contain [data-user-message-bubble]; other turns are assistant/status.
 * Voice turns that only show "Worked for Xs" become status.
 */
export const READ_THREAD_EXPRESSION = `(() => {
  const surfacePrefix = ${JSON.stringify(MAIN_CONTENT_SURFACE_CLASS_PREFIX)};
  const mains = Array.from(document.querySelectorAll('main'));
  const surface =
    mains.find((el) => typeof el.className === 'string' && el.className.includes(surfacePrefix))
    || (mains.length >= 2 ? mains[1] : null)
    || mains[0]
    || document.body;
  const scroll =
    surface.querySelector(${JSON.stringify(SELECTORS.timelineScroll)})
    || document.querySelector(${JSON.stringify(SELECTORS.timelineScroll)});
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

/** Experimental: focus the first matching composer; returns whether it was found. */
export const FOCUS_COMPOSER_EXPRESSION = `(() => {
  const composers = ${JSON.stringify([...COMPOSER_SELECTORS])};
  for (const sel of composers) {
    const composer = document.querySelector(sel);
    if (!composer) continue;
    composer.focus();
    return { ok: true, selector: sel, contentEditable: !!composer.isContentEditable };
  }
  return { ok: false, error: 'composer-not-found' };
})()`;

/** Experimental: fill composer via DOM when Input.insertText is unavailable. */
export function fillComposerExpression(text: string): string {
  return `(() => {
    const text = ${JSON.stringify(text)};
    const composers = ${JSON.stringify([...COMPOSER_SELECTORS])};
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
    return { ok: true };
  })()`;
}

/** Experimental: click send or press Enter on the focused composer. */
export const SUBMIT_COMPOSER_EXPRESSION = `(() => {
  const buttons = ${JSON.stringify([...SEND_BUTTON_SELECTORS])};
  for (const sel of buttons) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) {
      btn.click();
      return { ok: true, sentVia: 'button', selector: sel };
    }
  }
  const composers = ${JSON.stringify([...COMPOSER_SELECTORS])};
  let composer = null;
  for (const sel of composers) {
    composer = document.querySelector(sel);
    if (composer) break;
  }
  if (!composer) return { ok: false, error: 'composer-not-found' };
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ok: true, sentVia: 'enter' };
})()`;

/** @deprecated Prefer FOCUS + Input.insertText + SUBMIT; kept for tests/callers. */
export function sendMessageExpression(text: string): string {
  return fillComposerExpression(text);
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

/**
 * Experimental send: focus composer → CDP Input.insertText → submit
 * (send button or Enter). Falls back to DOM fill when insertText fails.
 */
export async function sendMessageInDom(
  session: CdpSession,
  sessionId: string,
  text: string,
): Promise<{ sentVia: string }> {
  const focused = await session.evaluate<{ ok: boolean; error?: string }>(
    FOCUS_COMPOSER_EXPRESSION,
    { sessionId },
  );
  if (!focused?.ok) {
    throw new Error('ChatGPT Desktop composer not found (experimental send path)');
  }

  let inserted = false;
  try {
    await session.send('Input.insertText', { text }, { sessionId });
    inserted = true;
  } catch {
    inserted = false;
  }
  if (!inserted) {
    const filled = await session.evaluate<{ ok: boolean; error?: string }>(
      fillComposerExpression(text),
      { sessionId },
    );
    if (!filled?.ok) {
      throw new Error(
        filled?.error === 'composer-not-found'
          ? 'ChatGPT Desktop composer not found (experimental send path)'
          : `ChatGPT Desktop send failed: ${filled?.error ?? 'fill-failed'}`,
      );
    }
  }

  const submitted = await session.evaluate<{ ok: boolean; sentVia?: string; error?: string }>(
    SUBMIT_COMPOSER_EXPRESSION,
    { sessionId },
  );
  if (!submitted?.ok) {
    throw new Error(`ChatGPT Desktop send submit failed: ${submitted?.error ?? 'unknown'}`);
  }
  return { sentVia: submitted.sentVia ?? (inserted ? 'insertText' : 'dom') };
}
