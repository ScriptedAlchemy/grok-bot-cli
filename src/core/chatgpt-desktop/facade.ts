import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerOpenThread,
  appServerReadThread,
  appServerStatusProbe,
} from './app-server-fallback.js';
import { CdpUnreachableError, NotImplementedError } from './errors.js';
import { resolveCdpPort } from './loopback.js';
import {
  isTemporaryDesktopThreadId,
  threadIdsEquivalent,
  toAppServerThreadId,
} from './thread-ids.js';
import type {
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ChatGptDesktopThread,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';

/** Optional overrides so tests can prove app-server / CDP routing without a live daemon. */
export type ChatGptDesktopFallbacks = {
  listThreads: typeof appServerListThreads;
  readThread: typeof appServerReadThread;
  openThread: typeof appServerOpenThread;
  statusProbe: typeof appServerStatusProbe;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  readThread: appServerReadThread,
  openThread: appServerOpenThread,
  statusProbe: appServerStatusProbe,
};

/**
 * ChatGPT Desktop facade.
 *
 * - List: app-server when available; merge CDP-only fields (pinned/selected/project).
 * - Read: visible/recent stays on CDP DOM; deep / full-history uses app-server
 *   (`thread/read` / resume with turns). DOM wheel crawl is last-resort only.
 * - Send, new-thread-in-project, wait-for-reply: CDP only.
 * - Every list/read/send/wait/open result reports `backend: "cdp" | "app-server"`.
 *
 * Reuses the existing Codex app-server client — never duplicates that JSON-RPC stack.
 */
export class ChatGptDesktopFacade implements ChatGptDesktopAdapter {
  #cdp: ChatGptDesktopAdapter;
  #port: number;
  #cdpConnected = false;
  #fallbacks: ChatGptDesktopFallbacks;

  constructor(
    cdp: ChatGptDesktopAdapter = new CdpChatGptDesktopAdapter(),
    port = resolveCdpPort(),
    fallbacks: ChatGptDesktopFallbacks = defaultFallbacks,
  ) {
    this.#cdp = cdp;
    this.#port = port;
    this.#fallbacks = fallbacks;
  }

  async connect({ port }: { port: number }): Promise<void> {
    this.#port = resolveCdpPort(process.env, port);
    try {
      await this.#cdp.connect({ port: this.#port });
      this.#cdpConnected = true;
    } catch (error) {
      this.#cdpConnected = false;
      throw error;
    }
  }

  async listTargets(): Promise<readonly ChatGptDesktopTarget[]> {
    await this.#ensureCdp();
    return this.#cdp.listTargets();
  }

  async listThreads(options?: { limit?: number }): Promise<ListThreadsResult> {
    let appList: ListThreadsResult | null = null;
    let appError: unknown;
    try {
      appList = await this.#fallbacks.listThreads(options);
    } catch (error) {
      appError = error;
    }

    let cdpList: ListThreadsResult | null = null;
    let cdpError: unknown;
    try {
      await this.#ensureCdp();
      cdpList = await this.#cdp.listThreads(options);
    } catch (error) {
      if (isCdpFailure(error)) {
        this.#cdpConnected = false;
      } else {
        cdpError = error;
      }
    }

    if (appList && cdpList) {
      return mergeThreadLists(appList, cdpList);
    }
    // App-server is primary; CDP merge is best-effort (skip NotImplemented / other DOM gaps).
    if (appList) return appList;
    if (cdpList) return cdpList;
    if (cdpError) throw cdpError;
    if (appError) throw appError;
    throw new CdpUnreachableError('ChatGPT Desktop listThreads: CDP and app-server unreachable');
  }

  async readThread(options: {
    threadId: string;
    limit?: number;
    full?: boolean;
    openTimeoutMs?: number;
  }): Promise<ReadThreadResult> {
    const limit = options.limit ?? 100;
    const full = options.full ?? false;
    const cdpConnected = await this.#tryEnsureCdp();

    // Temporary sidebar rows have no app-server mapping — CDP only.
    if (isTemporaryDesktopThreadId(options.threadId)) {
      if (!cdpConnected) {
        throw new CdpUnreachableError(
          `ChatGPT Desktop temporary thread ${options.threadId} requires CDP`,
        );
      }
      return this.#cdp.readThread({ ...options, limit, full });
    }

    // Quick visible/recent read via CDP when that is enough.
    if (cdpConnected && !full) {
      const visible = await this.#cdp.readThread({ ...options, limit, full: false });
      if (limit <= visible.turns.length) {
        return visible;
      }
      // Requested more turns than the DOM shows — escalate to app-server.
    }

    // Deep / full-history: app-server first.
    try {
      return await this.#fallbacks.readThread({
        threadId: options.threadId,
        limit,
        // Preserve caller intent: full=true takes history from the start;
        // otherwise return the most recent `limit` turns from full history.
        full,
      });
    } catch (appError) {
      // DOM wheel crawl only when app-server does not know the thread / is unreachable.
      if (cdpConnected) {
        return this.#cdp.readThread({ ...options, limit, full: true });
      }
      throw appError;
    }
  }

  async sendMessage(options: {
    threadId?: string;
    text: string;
    project?: string;
    openTimeoutMs?: number;
  }): Promise<SendMessageResult> {
    await this.#ensureCdp();
    return this.#cdp.sendMessage(options);
  }

  async waitForReply(options: {
    threadId?: string;
    timeoutMs?: number;
  }): Promise<WaitForReplyResult> {
    await this.#ensureCdp();
    return this.#cdp.waitForReply(options);
  }

  async openThread(
    threadId: string,
    options?: { openTimeoutMs?: number },
  ): Promise<OpenThreadResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.openThread(threadId, options);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.openThread(threadId);
    }
  }

  async status(): Promise<ChatGptDesktopStatus> {
    const cdpStatus = await this.#cdp.status();
    let appServerFallback: ChatGptDesktopStatus['appServerFallback'];
    try {
      appServerFallback = await this.#fallbacks.statusProbe();
    } catch {
      appServerFallback = { reachable: false };
    }
    const reachable = cdpStatus.reachable || Boolean(appServerFallback?.reachable);
    return {
      ...cdpStatus,
      port: this.#port,
      appServerFallback,
      reachable,
      message: cdpStatus.reachable
        ? cdpStatus.message
        : appServerFallback?.reachable
          ? 'CDP unreachable; Codex app-server available for list/deep-read'
          : cdpStatus.message,
      exitCode: reachable ? 0 : 1,
    };
  }

  async close(): Promise<void> {
    this.#cdpConnected = false;
    await this.#cdp.close();
  }

  async #ensureCdp(): Promise<void> {
    if (this.#cdpConnected) return;
    await this.#cdp.connect({ port: this.#port });
    this.#cdpConnected = true;
  }

  async #tryEnsureCdp(): Promise<boolean> {
    try {
      await this.#ensureCdp();
      return true;
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      this.#cdpConnected = false;
      return false;
    }
  }
}

/** Merge app-server thread inventory with CDP-only sidebar fields. */
export function mergeThreadLists(
  appList: ListThreadsResult,
  cdpList: ListThreadsResult,
): ListThreadsResult {
  const cdpByKey = new Map<string, ChatGptDesktopThread>();
  for (const thread of cdpList.threads) {
    const key = toAppServerThreadId(thread.threadId) ?? thread.threadId;
    cdpByKey.set(key, thread);
  }

  const merged: ChatGptDesktopThread[] = appList.threads.map((thread) => {
    const key = toAppServerThreadId(thread.threadId) ?? thread.threadId;
    const cdp = cdpByKey.get(key);
    if (!cdp) return thread;
    return {
      ...thread,
      title: thread.title || cdp.title,
      pinned: cdp.pinned,
      selected: cdp.selected,
      kind: cdp.kind || thread.kind,
      ...(cdp.project !== undefined ? { project: cdp.project } : {}),
    };
  });

  // Keep CDP-only rows (e.g. temporary local:client-new-thread:…) visible.
  for (const thread of cdpList.threads) {
    if (merged.some((row) => threadIdsEquivalent(row.threadId, thread.threadId))) continue;
    merged.push(thread);
  }

  return {
    backend: 'app-server',
    limit: appList.limit,
    threads: merged.slice(0, appList.limit),
  };
}

function isCdpFailure(error: unknown): boolean {
  if (error instanceof CdpUnreachableError) return true;
  if (error instanceof NotImplementedError) return false;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    return code === 'CDP_UNREACHABLE' || code === 'CDP_HOST_REJECTED';
  }
  return false;
}

let activeAdapter: ChatGptDesktopAdapter | null = null;

export function getChatGptDesktopAdapter(): ChatGptDesktopAdapter {
  if (!activeAdapter) activeAdapter = new ChatGptDesktopFacade();
  return activeAdapter;
}

/** Test hook: inject a fake adapter (or null to restore the default facade). */
export function setChatGptDesktopAdapterForTests(adapter: ChatGptDesktopAdapter | null): void {
  activeAdapter = adapter;
}
