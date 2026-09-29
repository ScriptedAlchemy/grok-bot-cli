import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerReadThread,
  appServerSearchThreads,
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
  searchThreads: typeof appServerSearchThreads;
  readThread: typeof appServerReadThread;
  statusProbe: typeof appServerStatusProbe;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  searchThreads: appServerSearchThreads,
  readThread: appServerReadThread,
  statusProbe: appServerStatusProbe,
};

/**
 * ChatGPT Desktop facade (verified against app-server 0.158.0).
 *
 * - List / search / read: app-server primary (`thread/list`, `thread/read` +
 *   `thread/turns/list`). DOM read is fallback only when app-server is unavailable.
 * - Send, new-thread-in-project, wait-for-reply, selected thread / UI state: CDP.
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
    if (appList) return appList;
    if (cdpList) return cdpList;
    if (cdpError) throw cdpError;
    if (appError) throw appError;
    throw new CdpUnreachableError('ChatGPT Desktop listThreads: CDP and app-server unreachable');
  }

  async searchThreads(options: {
    query: string;
    limit?: number;
  }): Promise<ListThreadsResult> {
    try {
      const appList = await this.#fallbacks.searchThreads(options);
      const cdpList = await this.#tryCdpList({ limit: options.limit });
      if (cdpList) return mergeThreadLists(appList, cdpList);
      return appList;
    } catch (appError) {
      const cdpList = await this.#tryCdpList({ limit: options.limit });
      if (!cdpList) throw appError;
      const needle = options.query.trim().toLowerCase();
      return {
        ...cdpList,
        query: options.query,
        threads: cdpList.threads.filter((thread) => {
          if (!needle) return true;
          return [thread.title, thread.threadId, thread.project]
            .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
        }),
      };
    }
  }

  async readThread(options: {
    threadId: string;
    limit?: number;
    full?: boolean;
    openTimeoutMs?: number;
  }): Promise<ReadThreadResult> {
    const limit = options.limit ?? 100;
    const full = options.full ?? false;

    // Temporary sidebar rows have no app-server mapping — CDP only.
    if (isTemporaryDesktopThreadId(options.threadId)) {
      await this.#ensureCdp();
      return this.#cdp.readThread({ ...options, limit, full });
    }

    // App-server is primary for all durable reads.
    try {
      return await this.#fallbacks.readThread({
        threadId: options.threadId,
        limit,
        full,
      });
    } catch (appError) {
      // DOM harvest / wheel crawl only when app-server is unavailable.
      const cdpConnected = await this.#tryEnsureCdp();
      if (!cdpConnected) throw appError;
      return this.#cdp.readThread({ ...options, limit, full: full || true });
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
    // Selected-thread / UI focus stays on CDP — do not thread/resume for this.
    await this.#ensureCdp();
    return this.#cdp.openThread(threadId, options);
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
          ? 'CDP unreachable; Codex app-server available for list/search/read'
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

  async #tryCdpList(options?: { limit?: number }): Promise<ListThreadsResult | null> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.listThreads(options);
    } catch (error) {
      if (isCdpFailure(error) || error instanceof NotImplementedError) {
        if (isCdpFailure(error)) this.#cdpConnected = false;
        return null;
      }
      throw error;
    }
  }
}

/** Merge app-server thread inventory with CDP-only sidebar fields (selected, etc.). */
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
      pinned: thread.pinned || cdp.pinned,
      selected: cdp.selected,
      kind: cdp.kind || thread.kind,
      project: cdp.project ?? thread.project,
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
    nextCursor: appList.nextCursor,
    ...(appList.query !== undefined ? { query: appList.query } : {}),
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
