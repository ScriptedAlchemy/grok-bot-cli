import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpUnreachableError } from './errors.js';
import { CdpSession } from './cdp-session.js';
import {
  DEFAULT_OPEN_TIMEOUT_MS,
  TEMP_THREAD_ID_PREFIX,
  listThreadsFromDom,
  openThreadInDom,
  pickMainWindowTarget,
  readReplyState,
  readTurnsFromDom,
  sendMessageInDom,
  startNewChatInDom,
  summarizeTargetInfos,
  waitForLoadingTaskGone,
  waitForReplyDone,
} from './cdp-dom.js';
import { resolveCdpPort } from './loopback.js';
import type {
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';

type TargetGetTargetsResult = {
  targetInfos?: Array<{
    targetId?: string;
    type?: string;
    title?: string;
    url?: string;
    attached?: boolean;
  }>;
};

/**
 * CDP-backed ChatGPT Desktop adapter. Selector/data logic stays in cdp-dom.ts.
 * Prefer Target.getTargets over /json/list (incomplete + unstable order).
 */
export class CdpChatGptDesktopAdapter implements ChatGptDesktopAdapter {
  #port = resolveCdpPort();
  #session: CdpSession | null = null;
  #version: Awaited<ReturnType<typeof CdpSession.fetchVersion>> | null = null;
  #pageSessionId: string | null = null;
  #mainTargetId: string | null = null;

  async connect({ port }: { port: number }): Promise<void> {
    await this.close();
    this.#port = resolveCdpPort(process.env, port);
    const session = new CdpSession(this.#port);
    try {
      this.#version = await session.connect();
      this.#session = session;
      await this.#attachMainWindow();
    } catch (error) {
      session.close();
      this.#session = null;
      throw error;
    }
  }

  async listTargets(): Promise<readonly ChatGptDesktopTarget[]> {
    const session = this.#requireSession();
    const result = await session.send<TargetGetTargetsResult>('Target.getTargets');
    return summarizeTargetInfos(result.targetInfos ?? []);
  }

  async listThreads({ limit = 50 }: { limit?: number } = {}): Promise<ListThreadsResult> {
    const sessionId = await this.#ensurePageSession();
    const threads = await listThreadsFromDom(this.#requireSession(), sessionId, { limit });
    return { threads, backend: 'cdp', limit };
  }

  async readThread({
    threadId,
    limit = 100,
    full = false,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  }: {
    threadId: string;
    limit?: number;
    full?: boolean;
    openTimeoutMs?: number;
  }): Promise<ReadThreadResult> {
    const sessionId = await this.#ensurePageSession();
    await this.#openAndWait(sessionId, threadId, openTimeoutMs);
    const turns = await readTurnsFromDom(this.#requireSession(), sessionId, {
      limit,
      full,
      threadId,
    });
    return { threadId, turns, backend: 'cdp', limit, full };
  }

  async sendMessage({
    threadId,
    text,
    project,
    openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
  }: {
    threadId?: string;
    text: string;
    project?: string;
    openTimeoutMs?: number;
  }): Promise<SendMessageResult> {
    const sessionId = await this.#ensurePageSession();
    let temporaryThreadId: string | undefined;
    let resolvedThreadId = threadId ?? 'new';

    if (threadId) {
      await this.#openAndWait(sessionId, threadId, openTimeoutMs);
    } else {
      await startNewChatInDom(this.#requireSession(), sessionId, { project });
      await delay(300);
      const threads = await listThreadsFromDom(this.#requireSession(), sessionId, { limit: 20 });
      const temp = threads.find((t) => t.threadId.startsWith(TEMP_THREAD_ID_PREFIX) && t.selected)
        ?? threads.find((t) => t.threadId.startsWith(TEMP_THREAD_ID_PREFIX));
      if (temp) {
        temporaryThreadId = temp.threadId;
        resolvedThreadId = temp.threadId;
      }
    }

    const { sentVia } = await sendMessageInDom(this.#requireSession(), sessionId, text);
    return {
      threadId: resolvedThreadId,
      temporaryThreadId,
      project,
      backend: 'cdp',
      experimental: false,
      delivery: 'accepted',
      sentVia,
      message: 'Submitted via CDP composer (focus → insertText → Enter)',
    };
  }

  async waitForReply({
    threadId,
    timeoutMs = 120_000,
  }: {
    threadId?: string;
    timeoutMs?: number;
  }): Promise<WaitForReplyResult> {
    const sessionId = await this.#ensurePageSession();
    if (threadId && !threadId.startsWith(TEMP_THREAD_ID_PREFIX) && threadId !== 'new') {
      // Stay on the current chat for temp/new; otherwise ensure the thread is open.
      try {
        await this.#openAndWait(sessionId, threadId, DEFAULT_OPEN_TIMEOUT_MS);
      } catch {
        // If already on the thread after send, continue waiting.
      }
    }

    const baseline = await readReplyState(this.#requireSession(), sessionId);
    try {
      const done = await waitForReplyDone(this.#requireSession(), sessionId, {
        timeoutMs,
        baselineFinalCount: baseline.finalAssistantCount,
      });
      const resolvedId = done.conversationId || threadId || 'unknown';
      return {
        threadId: resolvedId,
        conversationId: done.conversationId || undefined,
        reply: done.reply,
        backend: 'cdp',
        experimental: false,
        delivery: 'replied',
      };
    } catch (error) {
      const last = await readReplyState(this.#requireSession(), sessionId);
      return {
        threadId: last.conversationId || threadId || 'unknown',
        conversationId: last.conversationId || undefined,
        reply: last.reply,
        backend: 'cdp',
        experimental: false,
        delivery: last.reply ? 'replied' : 'timeout',
        ...(error instanceof Error ? {} : {}),
      };
    }
  }

  async openThread(
    threadId: string,
    { openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS }: { openTimeoutMs?: number } = {},
  ): Promise<OpenThreadResult> {
    const sessionId = await this.#ensurePageSession();
    await this.#openAndWait(sessionId, threadId, openTimeoutMs);
    return { threadId, backend: 'cdp' };
  }

  async status(): Promise<ChatGptDesktopStatus> {
    try {
      const version = this.#version ?? (await CdpSession.fetchVersion(this.#port));
      let targetCount: number | undefined;
      let mainWindowTargetId: string | null | undefined;
      if (this.#session && !this.#session.closed) {
        const targets = await this.listTargets();
        targetCount = targets.length;
        mainWindowTargetId = pickMainWindowTarget(targets)?.targetId ?? null;
      } else {
        const list = await CdpSession.fetchJsonList(this.#port);
        targetCount = list.length;
      }
      return {
        reachable: true,
        port: this.#port,
        host: '127.0.0.1',
        browser: typeof version.Browser === 'string' ? version.Browser : undefined,
        protocolVersion:
          typeof version['Protocol-Version'] === 'string' ? version['Protocol-Version'] : undefined,
        webSocketDebuggerUrl:
          typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : undefined,
        targetCount,
        mainWindowTargetId: mainWindowTargetId ?? this.#mainTargetId,
        message: 'ChatGPT Desktop CDP endpoint reachable on 127.0.0.1',
        exitCode: 0,
      };
    } catch (error) {
      return {
        reachable: false,
        port: this.#port,
        host: '127.0.0.1',
        message:
          error instanceof Error
            ? error.message
            : 'ChatGPT Desktop CDP endpoint unreachable on 127.0.0.1',
        exitCode: 1,
      };
    }
  }

  async close(): Promise<void> {
    this.#pageSessionId = null;
    this.#mainTargetId = null;
    this.#version = null;
    this.#session?.close();
    this.#session = null;
  }

  async #openAndWait(sessionId: string, threadId: string, openTimeoutMs: number): Promise<void> {
    await openThreadInDom(this.#requireSession(), sessionId, threadId);
    await waitForLoadingTaskGone(this.#requireSession(), sessionId, {
      timeoutMs: openTimeoutMs,
    });
  }

  async #attachMainWindow(): Promise<void> {
    const targets = await this.listTargets();
    const main = pickMainWindowTarget(targets);
    if (!main) {
      throw new CdpUnreachableError(
        `No ChatGPT Desktop main window target with url ${JSON.stringify('app://-/index.html')}`,
      );
    }
    const attached = await this.#requireSession().send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: main.targetId, flatten: true },
    );
    this.#mainTargetId = main.targetId;
    this.#pageSessionId = attached.sessionId;
  }

  async #ensurePageSession(): Promise<string> {
    this.#requireSession();
    if (!this.#pageSessionId) await this.#attachMainWindow();
    if (!this.#pageSessionId) {
      throw new CdpUnreachableError('Failed to attach to ChatGPT Desktop main window');
    }
    return this.#pageSessionId;
  }

  #requireSession(): CdpSession {
    if (!this.#session || this.#session.closed) {
      throw new CdpUnreachableError(
        'Not connected to ChatGPT Desktop CDP. Call connect({ port }) after relaunching with --remote-debugging-port.',
      );
    }
    return this.#session;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
