import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpUnreachableError } from './errors.js';
import { CdpSession } from './cdp-session.js';
import {
  listThreadsFromDom,
  openThreadInDom,
  pickMainWindowTarget,
  readTurnsFromDom,
  sendMessageInDom,
  summarizeTargetInfos,
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
      // Keep #port so status() can still probe /json/version on the same port.
      throw error;
    }
  }

  async listTargets(): Promise<readonly ChatGptDesktopTarget[]> {
    const session = this.#requireSession();
    // Target.getTargets is authoritative; /json/list is incomplete and order-unstable.
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
  }: {
    threadId: string;
    limit?: number;
  }): Promise<ReadThreadResult> {
    const sessionId = await this.#ensurePageSession();
    await openThreadInDom(this.#requireSession(), sessionId, threadId);
    // Allow the virtualized timeline to settle after the click.
    await delay(150);
    const turns = await readTurnsFromDom(this.#requireSession(), sessionId, { limit });
    return { threadId, turns, backend: 'cdp', limit };
  }

  async sendMessage({
    threadId,
    text,
  }: {
    threadId?: string;
    text: string;
  }): Promise<SendMessageResult> {
    const sessionId = await this.#ensurePageSession();
    if (threadId) {
      await openThreadInDom(this.#requireSession(), sessionId, threadId);
      await delay(100);
    }
    await sendMessageInDom(this.#requireSession(), sessionId, text);
    return {
      threadId: threadId ?? 'new',
      backend: 'cdp',
      experimental: true,
      delivery: 'accepted',
      message: 'Submitted via experimental CDP composer path',
    };
  }

  async waitForReply({
    threadId,
    timeoutMs = 60000,
  }: {
    threadId: string;
    timeoutMs?: number;
  }): Promise<WaitForReplyResult> {
    const sessionId = await this.#ensurePageSession();
    await openThreadInDom(this.#requireSession(), sessionId, threadId);
    const deadline = Date.now() + timeoutMs;
    let previousKeys = new Set<string>();
    let lastAssistant = '';
    let stable = 0;

    // Baseline existing turns so we wait for a *new* assistant turn.
    const baseline = await readTurnsFromDom(this.#requireSession(), sessionId, { limit: 500 });
    previousKeys = new Set(baseline.map((t) => t.turnKey));

    while (Date.now() < deadline) {
      await delay(400);
      const turns = await readTurnsFromDom(this.#requireSession(), sessionId, { limit: 500 });
      const fresh = turns.filter((t) => !previousKeys.has(t.turnKey) && t.role === 'assistant');
      const candidate = fresh.at(-1)?.text ?? '';
      if (candidate && candidate === lastAssistant) {
        stable += 1;
        if (stable >= 3) {
          return {
            threadId,
            reply: candidate,
            backend: 'cdp',
            experimental: true,
            delivery: 'replied',
          };
        }
      } else if (candidate) {
        lastAssistant = candidate;
        stable = 0;
      }
    }
    return {
      threadId,
      reply: lastAssistant,
      backend: 'cdp',
      experimental: true,
      delivery: lastAssistant ? 'replied' : 'timeout',
    };
  }

  async openThread(threadId: string): Promise<OpenThreadResult> {
    const sessionId = await this.#ensurePageSession();
    await openThreadInDom(this.#requireSession(), sessionId, threadId);
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
        // Cheap probe without attaching: /json/list is incomplete but fine for a count hint.
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
