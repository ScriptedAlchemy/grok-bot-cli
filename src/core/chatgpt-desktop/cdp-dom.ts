/**
 * ChatGPT Desktop DOM / data-layer for CDP Runtime.evaluate + Input events.
 *
 * ALL selector and in-page data extraction lives in this module. Verified live
 * on macOS ChatGPT.app (com.openai.codex, Chrome 154).
 */

import type { ChatGptDesktopTarget, ChatGptDesktopThread, ChatGptDesktopTurn } from './types.js';
import type { CdpSession } from './cdp-session.js';
import { ArchivedThreadError, ComposerDraftError } from './errors.js';
import {
  LOCAL_THREAD_ID_PREFIX,
  isTemporaryDesktopThreadId,
  normalizeCodexThreadId,
} from '../codex/thread-id.js';

/** Exact main-window URL; ignore overlays / detached / webviews. */
export const MAIN_WINDOW_URL = 'app://-/index.html';

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
  composer: 'data-codex-composer',
  finalAssistant: 'data-local-conversation-final-assistant',
  markdownTextStyle: 'data-markdown-text-style',
  conversationAnnotation: 'data-response-annotation-conversation',
} as const;

export const MAIN_CONTENT_SURFACE_CLASS_PREFIX = '_MainContentSurface';
export const HISTORY_GAP_PREFIX = 'history-gap:';
export const TEMP_THREAD_ID_PREFIX = 'local:client-new-thread:';
export const LOADING_TASK_TEXT = 'Loading task…';
export const DEFAULT_OPEN_TIMEOUT_MS = 90_000;
/** How long a new-thread send waits for the real conversation annotation. */
export const DEFAULT_CONVERSATION_RESOLVE_MS = 60_000;
export const DEFAULT_FULL_READ_IDLE_WHEELS = 8;
export const DEFAULT_FULL_READ_MAX_WHEELS = 400;
/**
 * Timeline is `column-reverse`: scrollTop 0 is the newest message. Setting
 * scrollTop does not load older history — use mouseWheel with this deltaY
 * (negative = toward older turns).
 */
export const FULL_READ_WHEEL_DELTA_Y = -800;

/** Verified composer: contenteditable textbox. */
export const COMPOSER_SELECTOR =
  `[${ATTR.composer}="true"][contenteditable="true"]` as const;

/** Verified send button (only present while the composer has text). */
export const SEND_BUTTON_SELECTOR = 'button[aria-label="Send"]' as const;

/** Stop button in main — present while a reply is streaming. */
export const STOP_BUTTON_SELECTOR = 'main button[aria-label="Stop"]' as const;

/** Final assistant marker + markdown body inside a turn. */
export const FINAL_ASSISTANT_SELECTOR =
  `[${ATTR.finalAssistant}="true"]` as const;
export const ASSISTANT_MESSAGE_SELECTOR =
  `[${ATTR.finalAssistant}="true"] [${ATTR.markdownTextStyle}="assistant-message"]` as const;

/** Conversation id annotation inside a reply. */
export const CONVERSATION_ANNOTATION_SELECTOR =
  `[${ATTR.conversationAnnotation}]` as const;

export const SELECTORS = {
  threadRow: `[role="button"][${ATTR.threadRow}]`,
  turn: `[${ATTR.turnKey}]`,
  userBubble: `[${ATTR.userBubble}]`,
  timelineScroll: `[${ATTR.timelineScroll}]`,
  composer: COMPOSER_SELECTOR,
  sendButton: SEND_BUTTON_SELECTOR,
  stopButton: STOP_BUTTON_SELECTOR,
  finalAssistant: FINAL_ASSISTANT_SELECTOR,
  assistantMessage: ASSISTANT_MESSAGE_SELECTOR,
  conversationAnnotation: CONVERSATION_ANNOTATION_SELECTOR,
  newChatFallback: 'button',
} as const;

export function newChatInProjectSelector(project: string): string {
  return `button[aria-label=${JSON.stringify(`Start new chat in ${project}`)}]`;
}

export function isMainWindowTarget(target: {
  type?: string;
  url?: string;
}): boolean {
  if (target.type !== 'page') return false;
  const url = typeof target.url === 'string' ? target.url : '';
  if (url !== MAIN_WINDOW_URL) return false;
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

/** Dedupe sidebar rows (Recent + project can both list the same id). */
export function dedupeThreadsById(
  threads: readonly ChatGptDesktopThread[],
): ChatGptDesktopThread[] {
  const byKey = new Map<string, ChatGptDesktopThread>();
  for (const thread of threads) {
    if (!thread.threadId) continue;
    const key = durableThreadKey(thread.threadId);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, thread);
      continue;
    }
    byKey.set(key, preferThreadRow(existing, thread));
  }
  return [...byKey.values()];
}

function durableThreadKey(threadId: string): string {
  if (isTemporaryDesktopThreadId(threadId)) return threadId;
  try {
    return normalizeCodexThreadId(threadId);
  } catch {
    return threadId.startsWith(LOCAL_THREAD_ID_PREFIX)
      ? threadId.slice(LOCAL_THREAD_ID_PREFIX.length) || threadId
      : threadId;
  }
}

function toDesktopForm(threadId: string): string {
  if (!threadId || isTemporaryDesktopThreadId(threadId)) return threadId;
  if (threadId.startsWith(LOCAL_THREAD_ID_PREFIX)) return threadId;
  return `${LOCAL_THREAD_ID_PREFIX}${threadId}`;
}

function preferThreadRow(
  left: ChatGptDesktopThread,
  right: ChatGptDesktopThread,
): ChatGptDesktopThread {
  const score = (row: ChatGptDesktopThread) =>
    (row.selected ? 4 : 0)
    + (row.pinned ? 2 : 0)
    + (row.threadId.startsWith(LOCAL_THREAD_ID_PREFIX) && !isTemporaryDesktopThreadId(row.threadId)
      ? 1
      : 0);
  return score(right) > score(left) ? right : left;
}

export const LIST_THREADS_EXPRESSION = `(() => {
  const skipProjectLabels = new Set(['Recent', 'Pinned', 'Threads', 'Chats']);
  const projectFor = (row) => {
    let el = row.parentElement;
    for (let i = 0; i < 8 && el; i += 1, el = el.parentElement) {
      const attr =
        el.getAttribute('data-app-action-sidebar-project') ||
        el.getAttribute('data-app-action-sidebar-project-name') ||
        el.getAttribute('data-app-action-sidebar-section-title');
      if (attr && !skipProjectLabels.has(attr)) return attr;
    }
    return undefined;
  };
  const rows = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)}));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const threadId = row.getAttribute(${JSON.stringify(ATTR.threadId)}) || '';
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    const project = projectFor(row);
    out.push({
      threadId,
      hostId: row.getAttribute('data-app-action-sidebar-thread-host-id') || null,
      title: row.getAttribute(${JSON.stringify(ATTR.threadTitle)}) || (row.textContent || '').trim(),
      pinned: row.getAttribute(${JSON.stringify(ATTR.threadPinned)}) === 'true',
      selected: row.getAttribute(${JSON.stringify(ATTR.threadSelected)}) === 'true',
      kind: row.getAttribute(${JSON.stringify(ATTR.threadKind)}) || 'unknown',
      ...(project ? { project } : {}),
    });
  }
  return out;
})()`;

export function openThreadExpression(threadId: string): string {
  const bare = durableThreadKey(threadId);
  const desktop = toDesktopForm(bare);
  const candidates = [...new Set([threadId, bare, desktop].filter(Boolean))];
  return `(() => {
    const candidates = ${JSON.stringify(candidates)};
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.threadRow)}));
    const row = rows.find((el) =>
      candidates.includes(el.getAttribute(${JSON.stringify(ATTR.threadId)}) || ''),
    );
    if (!row) return { ok: false, error: 'thread-not-found' };
    row.click();
    return { ok: true, threadId: row.getAttribute(${JSON.stringify(ATTR.threadId)}) || candidates[0] };
  })()`;
}

/** Desktop uses a memory router; the browser URL stays app://-/index.html. */
export function navigateToThreadExpression(threadId: string): string {
  const bare = durableThreadKey(threadId);
  return `(async () => {
    const root = window.__codexRoot?._internalRoot?.current;
    const queue = [root];
    let scanned = 0;
    while (queue.length && scanned++ < 10000) {
      const fiber = queue.shift();
      if (!fiber) continue;
      const router = fiber.memoizedProps?.router;
      if (router?.navigate && router?.state?.location) {
        await router.navigate(${JSON.stringify(`/local/${bare}`)});
        return { ok: true, via: 'router' };
      }
      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
    }
    return { ok: false, error: 'router-not-found' };
  })()`;
}

export function startNewChatExpression(project?: string): string {
  const projectSel = project ? newChatInProjectSelector(project) : null;
  return `(() => {
    const projectSel = ${JSON.stringify(projectSel)};
    if (projectSel) {
      const preferred = document.querySelector(projectSel);
      if (preferred) {
        const row = preferred.closest('.group') || preferred.parentElement;
        row?.scrollIntoView({ block: 'center' });
        const rowBox = row?.getBoundingClientRect();
        return { ok: true, via: 'project', project: ${JSON.stringify(project ?? null)},
          hoverX: rowBox?.left + rowBox?.width / 2, hoverY: rowBox?.top + rowBox?.height / 2 };
      }
      return { ok: false, error: 'project-not-found' };
    }
    const buttons = Array.from(document.querySelectorAll('button'));
    const fallback = buttons.find((btn) => (btn.textContent || '').trim() === 'New chat');
    if (!fallback) return { ok: false, error: 'new-chat-not-found' };
    fallback.click();
    return { ok: true, via: 'fallback' };
  })()`;
}

export function projectButtonBoxExpression(project: string): string {
  return `(() => {
    const button = document.querySelector(${JSON.stringify(newChatInProjectSelector(project))});
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
      visible: box.width > 0 && box.height > 0 && getComputedStyle(button.parentElement).opacity !== '0' };
  })()`;
}

export const LOADING_TASK_GONE_EXPRESSION = `(() => {
  const surfacePrefix = ${JSON.stringify(MAIN_CONTENT_SURFACE_CLASS_PREFIX)};
  const mains = Array.from(document.querySelectorAll('main'));
  const surface =
    mains.find((el) => typeof el.className === 'string' && el.className.includes(surfacePrefix))
    || (mains.length >= 2 ? mains[1] : null)
    || mains[0]
    || document.body;
  const text = (surface.innerText || '').replace(/\\u2026/g, '…');
  return !text.includes(${JSON.stringify(LOADING_TASK_TEXT)});
})()`;

export const ARCHIVED_THREAD_EXPRESSION = `(() => Array.from(document.querySelectorAll('main'))
  .some((main) => (main.innerText || '').includes('This task is archived')
    && (main.innerText || '').includes('Unarchive this task to open it')))()`;

export const FOCUS_COMPOSER_EXPRESSION = `(() => {
  const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
  if (!composer) return { ok: false, error: 'composer-not-found' };
  if ((composer.textContent || '').trim()) return { ok: false, error: 'composer-has-draft' };
  if (document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)})) return { ok: false, error: 'reply-in-progress' };
  composer.focus();
  return { ok: true };
})()`;

export const REPLY_STATE_EXPRESSION = `(() => {
  const stop = document.querySelector(${JSON.stringify(STOP_BUTTON_SELECTOR)});
  const finals = Array.from(document.querySelectorAll(${JSON.stringify(FINAL_ASSISTANT_SELECTOR)}));
  const lastFinal = finals.at(-1) || null;
  const annotation = lastFinal
    ? lastFinal.querySelector(${JSON.stringify(CONVERSATION_ANNOTATION_SELECTOR)})
      || lastFinal.closest(${JSON.stringify(SELECTORS.turn)})?.querySelector(${JSON.stringify(CONVERSATION_ANNOTATION_SELECTOR)})
    : document.querySelector(${JSON.stringify(CONVERSATION_ANNOTATION_SELECTOR)});
  const conversationId = annotation
    ? (annotation.getAttribute(${JSON.stringify(ATTR.conversationAnnotation)}) || '')
    : '';
  const messageEl = lastFinal
    ? lastFinal.querySelector(${JSON.stringify(`[${ATTR.markdownTextStyle}="assistant-message"]`)})
    : null;
  const reply = messageEl ? (messageEl.innerText || '').trim() : '';
  const turns = Array.from(document.querySelectorAll(${JSON.stringify(SELECTORS.turn)}));
  const lastTurn = turns.at(-1);
  const lastTurnKey = lastTurn ? (lastTurn.getAttribute(${JSON.stringify(ATTR.turnKey)}) || '') : '';
  return {
    stopVisible: Boolean(stop),
    finalAssistantCount: finals.length,
    conversationId,
    reply,
    lastTurnKey,
    finalTurnKey: lastFinal?.closest(${JSON.stringify(SELECTORS.turn)})?.getAttribute(${JSON.stringify(ATTR.turnKey)}) || '',
  };
})()`;

/** Any conversation annotation on the page (user turn or assistant). */
export const CONVERSATION_ID_EXPRESSION = `(() => {
  const annotation = document.querySelector(${JSON.stringify(CONVERSATION_ANNOTATION_SELECTOR)});
  return annotation
    ? (annotation.getAttribute(${JSON.stringify(ATTR.conversationAnnotation)}) || '')
    : '';
})()`;

/**
 * Harvest currently rendered turns (no wheel). One turn may hold both the user
 * bubble and the final assistant reply. Skip history-gap placeholders.
 */
export const HARVEST_VISIBLE_TURNS_EXPRESSION = `(() => {
  const gapPrefix = ${JSON.stringify(HISTORY_GAP_PREFIX)};
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
  const out = [];
  for (const el of root.querySelectorAll(${JSON.stringify(SELECTORS.turn)})) {
    const turnKey = el.getAttribute(${JSON.stringify(ATTR.turnKey)}) || '';
    if (!turnKey || turnKey.startsWith(gapPrefix)) continue;
    const user = el.querySelector(${JSON.stringify(SELECTORS.userBubble)});
    const assistant = el.querySelector(${JSON.stringify(ASSISTANT_MESSAGE_SELECTOR)});
    const userText = user ? (user.innerText || '').trim() : '';
    const assistantText = assistant ? (assistant.innerText || '').trim() : '';
    const raw = (el.innerText || '').trim();
    const statusRe = /^Worked for \\d+s$/i;
    let role = 'assistant';
    let text = assistantText || userText || raw;
    if (user && !assistantText) {
      role = 'user';
      text = userText || raw;
    } else if (assistantText) {
      role = 'assistant';
      text = assistantText;
    } else if (!raw || statusRe.test(raw)) {
      role = 'status';
      text = raw;
    }
    out.push({ turnKey, role, text, userText, assistantText });
  }
  return out;
})()`;

export const TIMELINE_SCROLL_METRICS_EXPRESSION = `(() => {
  const scroll = document.querySelector(${JSON.stringify(SELECTORS.timelineScroll)});
  if (!scroll) return { ok: false };
  const rect = scroll.getBoundingClientRect();
  return {
    ok: true,
    x: Math.floor(rect.left + rect.width / 2),
    y: Math.floor(rect.top + Math.min(rect.height / 2, 120)),
    scrollTop: scroll.scrollTop,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight,
  };
})()`;

export async function listThreadsFromDom(
  session: CdpSession,
  sessionId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<ChatGptDesktopThread[]> {
  const rows = await session.evaluate<ChatGptDesktopThread[]>(LIST_THREADS_EXPRESSION, { sessionId });
  if (!Array.isArray(rows)) return [];
  return dedupeThreadsById(rows).slice(0, limit).map((row) => ({
    threadId: String(row.threadId),
    title: String(row.title ?? ''),
    pinned: Boolean(row.pinned),
    selected: Boolean(row.selected),
    kind: String(row.kind ?? 'unknown'),
    ...(row.hostId ? { hostId: row.hostId, location: row.hostId === 'local' ? 'local' as const : 'remote' as const } : {}),
    ...(row.project ? { project: String(row.project) } : {}),
  }));
}

export async function openThreadInDom(
  session: CdpSession,
  sessionId: string,
  threadId: string,
): Promise<void> {
  const current = await readConversationIdFromDom(session, sessionId);
  if (current && durableThreadKey(current) === durableThreadKey(threadId)) return;
  if (isTemporaryDesktopThreadId(threadId)) {
    const rows = await listThreadsFromDom(session, sessionId, { limit: 200 });
    if (rows.some((row) => row.selected && row.threadId === threadId)) return;
  }
  const result = await session.evaluate<{ ok: boolean; error?: string }>(
    openThreadExpression(threadId),
    { sessionId },
  );
  if (!result?.ok) {
    if (result?.error === 'thread-not-found' && !isTemporaryDesktopThreadId(threadId)) {
      const navigated = await session.evaluate<{ ok: boolean }>(navigateToThreadExpression(threadId), { sessionId });
      if (navigated?.ok) return;
    }
    throw new Error(
      result?.error === 'thread-not-found'
        ? `ChatGPT Desktop thread not found: ${threadId}`
        : `Failed to open ChatGPT Desktop thread ${threadId}`,
    );
  }
}

export async function waitForLoadingTaskGone(
  session: CdpSession,
  sessionId: string,
  { timeoutMs = DEFAULT_OPEN_TIMEOUT_MS, threadId }: { timeoutMs?: number; threadId?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let loadingGone = false;
  let lastConversationId = '';
  let archivedSince: number | null = null;
  while (Date.now() < deadline) {
    if (threadId && threadId !== 'new' && await session.evaluate<boolean>(ARCHIVED_THREAD_EXPRESSION, { sessionId }) === true) {
      archivedSince ??= Date.now();
      if (Date.now() - archivedSince >= 500) {
        throw new ArchivedThreadError(threadId);
      }
    } else {
      archivedSince = null;
    }
    const gone = await session.evaluate<boolean>(LOADING_TASK_GONE_EXPRESSION, { sessionId });
    loadingGone ||= gone;
    if (gone) {
      // A click can resolve before React replaces the previous timeline.
      const current = threadId ? await readConversationIdFromDom(session, sessionId) : '';
      lastConversationId = current;
      if (!threadId) return;
      if (threadId === 'new' || isTemporaryDesktopThreadId(threadId)) {
        const rows = await listThreadsFromDom(session, sessionId, { limit: 200 });
        const selected = rows.find((row) => row.selected);
        if (!current && (!selected || isTemporaryDesktopThreadId(selected.threadId))) return;
      } else if (current && durableThreadKey(current) === durableThreadKey(threadId)) return;
    }
    await delay(250);
  }
  throw new Error(
    loadingGone
      ? `ChatGPT Desktop timed out waiting for conversation ${JSON.stringify(threadId)}; displayed conversation ${JSON.stringify(lastConversationId)} after ${timeoutMs}ms`
      : `ChatGPT Desktop thread still showing ${JSON.stringify(LOADING_TASK_TEXT)} after ${timeoutMs}ms`,
  );
}

export async function startNewChatInDom(
  session: CdpSession,
  sessionId: string,
  { project }: { project?: string } = {},
): Promise<{ via: string }> {
  const result = await session.evaluate<{ ok: boolean; via?: string; error?: string; x?: number; y?: number; hoverX?: number; hoverY?: number }>(
    startNewChatExpression(project),
    { sessionId },
  );
  if (!result?.ok) {
    throw new Error(
      project
        ? `ChatGPT Desktop new-chat button not found for project ${JSON.stringify(project)}`
        : 'ChatGPT Desktop "New chat" button not found',
    );
  }
  if (result.via === 'project') {
    if (![result.hoverX, result.hoverY].every(Number.isFinite)) {
      throw new Error(`ChatGPT Desktop project button has no visible box for ${JSON.stringify(project)}`);
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: result.hoverX, y: result.hoverY }, { sessionId });
    const button = await session.evaluate<{ x: number; y: number; visible: boolean } | null>(projectButtonBoxExpression(project!), { sessionId });
    if (!button?.visible || !Number.isFinite(button.x) || !Number.isFinite(button.y)) {
      throw new Error(`ChatGPT Desktop project button did not appear after hover for ${JSON.stringify(project)}`);
    }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y }, { sessionId });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 }, { sessionId });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 }, { sessionId });
  }
  return { via: result.via ?? 'unknown' };
}

export async function focusComposer(
  session: CdpSession,
  sessionId: string,
): Promise<void> {
  const focused = await session.evaluate<{ ok: boolean; error?: string }>(
    FOCUS_COMPOSER_EXPRESSION,
    { sessionId },
  );
  if (!focused?.ok) {
    if (focused?.error === 'composer-has-draft') throw new ComposerDraftError();
    throw new Error(`ChatGPT Desktop composer unavailable: ${focused?.error || 'not found'}`);
  }
}

/** Submit via Enter key events (preferred). */
export async function submitComposerWithEnter(
  session: CdpSession,
  sessionId: string,
): Promise<void> {
  const base = {
    windowsVirtualKeyCode: 13,
    code: 'Enter',
    key: 'Enter',
    text: '\r',
    unmodifiedText: '\r',
  };
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, { sessionId });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, { sessionId });
}

export async function sendMessageInDom(
  session: CdpSession,
  sessionId: string,
  text: string,
): Promise<{ sentVia: 'enter' }> {
  await focusComposer(session, sessionId);
  await session.send('Input.insertText', { text }, { sessionId });
  try {
    await submitComposerWithEnter(session, sessionId);
    // Never retry submission just because React has not cleared the button yet.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const cleared = await session.evaluate<boolean>(`(() => {
        const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
        return Boolean(composer && !(composer.textContent || '').trim());
      })()`, { sessionId });
      if (cleared) return { sentVia: 'enter' };
      await delay(100);
    }
    throw new Error('Desktop composer did not acknowledge submission');
  } catch (error) {
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
      delivery: 'unknown', reason: 'submission-unconfirmed',
    });
  }
}

export type ReplyState = {
  stopVisible: boolean;
  finalAssistantCount: number;
  conversationId: string;
  reply: string;
  lastTurnKey: string;
  finalTurnKey?: string;
};

export async function readReplyState(
  session: CdpSession,
  sessionId: string,
): Promise<ReplyState> {
  const state = await session.evaluate<ReplyState>(REPLY_STATE_EXPRESSION, { sessionId });
  return {
    stopVisible: Boolean(state?.stopVisible),
    finalAssistantCount: Number(state?.finalAssistantCount ?? 0),
    conversationId: String(state?.conversationId ?? ''),
    reply: String(state?.reply ?? ''),
    lastTurnKey: String(state?.lastTurnKey ?? ''),
    finalTurnKey: String(state?.finalTurnKey ?? ''),
  };
}

/** Read the current `data-response-annotation-conversation` value, if any. */
export async function readConversationIdFromDom(
  session: CdpSession,
  sessionId: string,
): Promise<string> {
  const value = await session.evaluate<string>(CONVERSATION_ID_EXPRESSION, { sessionId });
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Wait until the real conversation id appears on
 * `[data-response-annotation-conversation]`. Rejects temporary sidebar ids.
 */
export async function waitForConversationId(
  session: CdpSession,
  sessionId: string,
  { timeoutMs = DEFAULT_CONVERSATION_RESOLVE_MS }: { timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await readConversationIdFromDom(session, sessionId);
    if (id && !isTemporaryDesktopThreadId(id) && !id.startsWith(TEMP_THREAD_ID_PREFIX)) {
      return id;
    }
    await delay(200);
  }
  throw new Error(
    `ChatGPT Desktop conversation id did not appear on [data-response-annotation-conversation] within ${timeoutMs}ms`,
  );
}

/**
 * Prefer a durable Desktop thread id. Never returns `local:client-new-thread:*`.
 */
export function resolveDurableThreadId(
  conversationId: string | null | undefined,
  fallbackThreadId?: string | null,
): string | null {
  if (conversationId && !isTemporaryDesktopThreadId(conversationId)) {
    return toDesktopForm(conversationId);
  }
  if (
    fallbackThreadId
    && !isTemporaryDesktopThreadId(fallbackThreadId)
    && fallbackThreadId !== 'new'
  ) {
    return toDesktopForm(fallbackThreadId);
  }
  return null;
}

/**
 * Wait until Stop is gone and a new final-assistant marker exists.
 * Returns reply text + conversation id from the annotation.
 */
export class ReplyTimeoutError extends Error {}

export async function waitForReplyDone(
  session: CdpSession,
  sessionId: string,
  {
    timeoutMs = 120_000,
    baselineFinalCount = 0,
    expectedConversationId,
    baselineTurnKey,
  }: { timeoutMs?: number; baselineFinalCount?: number; expectedConversationId?: string; baselineTurnKey?: string } = {},
): Promise<{ reply: string; conversationId: string }> {
  const deadline = Date.now() + timeoutMs;
  let sawStop = false;
  const started = Date.now();
  while (Date.now() < deadline) {
    const state = await readReplyState(session, sessionId);
    if (state.stopVisible) sawStop = true;
    expectedConversationId ??= state.conversationId || undefined;
    if (expectedConversationId && state.conversationId
      && durableThreadKey(state.conversationId) !== durableThreadKey(expectedConversationId)) {
      throw new Error('ChatGPT Desktop selected conversation changed while waiting');
    }
    const latestIsFinal = Boolean(state.finalTurnKey) && state.finalTurnKey === state.lastTurnKey;
    const hasNewFinal = (state.finalAssistantCount > baselineFinalCount || sawStop)
      && Boolean(state.reply) && latestIsFinal
      && (!baselineTurnKey || state.lastTurnKey !== baselineTurnKey);
    // Stop appears within ~1s of submit; done when Stop is gone AND a new final exists.
    if (!state.stopVisible && hasNewFinal && (sawStop || Date.now() - started > 1500)) {
      return { reply: state.reply, conversationId: state.conversationId };
    }
    await delay(200);
  }
  throw new ReplyTimeoutError(`ChatGPT Desktop reply did not finish within ${timeoutMs}ms`);
}

function normalizeTurn(raw: {
  turnKey?: string;
  role?: string;
  text?: string;
  userText?: string;
  assistantText?: string;
}): ChatGptDesktopTurn {
  const role =
    raw.role === 'user' || raw.role === 'status' || raw.role === 'assistant'
      ? raw.role
      : raw.assistantText
        ? 'assistant'
        : raw.userText
          ? 'user'
          : 'assistant';
  return {
    turnKey: String(raw.turnKey ?? ''),
    role,
    text: String(raw.text ?? raw.assistantText ?? raw.userText ?? ''),
    userText: raw.userText ? String(raw.userText) : undefined,
    assistantText: raw.assistantText ? String(raw.assistantText) : undefined,
  };
}

export async function harvestVisibleTurns(
  session: CdpSession,
  sessionId: string,
): Promise<ChatGptDesktopTurn[]> {
  const rows = await session.evaluate<Array<Parameters<typeof normalizeTurn>[0]>>(
    HARVEST_VISIBLE_TURNS_EXPRESSION,
    { sessionId },
  );
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeTurn).filter((t) => t.turnKey && !t.turnKey.startsWith(HISTORY_GAP_PREFIX));
}

/**
 * Full history crawl: the timeline is column-reverse; scrollTop scripting does
 * not load older turns (yields history-gap placeholders). Wheel with negative
 * deltaY over the container, collect by data-turn-key, skip history-gap keys,
 * stop after idle wheels or when a turn key equals the thread id.
 */
export async function readTurnsFromDom(
  session: CdpSession,
  sessionId: string,
  {
    limit = 100,
    full = false,
    threadId,
    idleWheels = DEFAULT_FULL_READ_IDLE_WHEELS,
    maxWheels = DEFAULT_FULL_READ_MAX_WHEELS,
  }: {
    limit?: number;
    full?: boolean;
    threadId?: string;
    idleWheels?: number;
    maxWheels?: number;
  } = {},
): Promise<ChatGptDesktopTurn[]> {
  const collected = new Map<string, ChatGptDesktopTurn>();
  const order: string[] = [];
  const ingest = async () => {
    const older: string[] = [];
    for (const turn of await harvestVisibleTurns(session, sessionId)) {
      if (!collected.has(turn.turnKey)) older.push(turn.turnKey);
      collected.set(turn.turnKey, turn);
    }
    order.unshift(...older);
  };

  await ingest();
  if (!full) {
    const visible = order.map((key) => collected.get(key)!);
    return limit > 0 ? visible.slice(-limit) : visible;
  }

  let idle = 0;
  for (let step = 0; step < maxWheels; step++) {
    const before = collected.size;
    const metrics = await session.evaluate<{
      ok: boolean;
      x?: number;
      y?: number;
    }>(TIMELINE_SCROLL_METRICS_EXPRESSION, { sessionId });
    if (!metrics?.ok || metrics.x == null || metrics.y == null) break;

    await session.send(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseWheel',
        x: metrics.x,
        y: metrics.y,
        deltaX: 0,
        deltaY: FULL_READ_WHEEL_DELTA_Y,
      },
      { sessionId },
    );
    await delay(120);
    await ingest();

    if (collected.size === before) {
      idle += 1;
      if (idle >= idleWheels) break;
    } else {
      idle = 0;
    }
    if (threadId && collected.has(threadId)) break;
  }

  const all = order.map((key) => collected.get(key)!);
  return limit > 0 ? all.slice(0, limit) : all;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
