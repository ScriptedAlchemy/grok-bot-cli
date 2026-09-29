import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerReadThread,
  appServerSearchThreads,
  appServerStatusProbe,
} from './app-server-fallback.js';
import { CdpUnreachableError, NotImplementedError, RemoteThreadNotLoadedError } from './errors.js';
import { resolveCdpPort } from './loopback.js';
import { listRemoteThreadsFromState } from './remote-threads.js';
import {
  isTemporaryDesktopThreadId,
  threadIdsEquivalent,
  toAppServerThreadId,
} from './thread-ids.js';
import type {
  ChatGptDesktopHostGroup,
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
  listRemoteThreads?: typeof listRemoteThreadsFromState;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  searchThreads: appServerSearchThreads,
  readThread: appServerReadThread,
  statusProbe: appServerStatusProbe,
  listRemoteThreads: listRemoteThreadsFromState,
};

export type ListThreadsOptions = {
  limit?: number;
  /** Filter by remote hostId or friendly host/env name (substring, case-insensitive). */
  host?: string;
  /** When `"host"`, also return `groups` keyed by host. */
  groupBy?: 'host';
};

/**
 * ChatGPT Desktop facade (verified against app-server 0.158.0).
 *
 * - List / search / read: app-server primary; list also merges remote-control
 *   summaries from `~/.codex/.codex-global-state.json`.
 * - Send, new-thread-in-project, wait-for-reply, selected thread / UI state: CDP.
 * - Every list/read/send/wait/open result reports `backend: "cdp" | "app-server"`.
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

  async listThreads(options: ListThreadsOptions = {}): Promise<ListThreadsResult> {
    const limit = options.limit ?? 50;
    let appList: ListThreadsResult | null = null;
    let appError: unknown;
    try {
      appList = await this.#fallbacks.listThreads({ limit });
    } catch (error) {
      appError = error;
    }

    let cdpList: ListThreadsResult | null = null;
    let cdpError: unknown;
    try {
      await this.#ensureCdp();
      cdpList = await this.#cdp.listThreads({ limit });
    } catch (error) {
      if (isCdpFailure(error)) {
        this.#cdpConnected = false;
      } else {
        cdpError = error;
      }
    }

    let base: ListThreadsResult | null = null;
    if (appList && cdpList) base = mergeThreadLists(appList, cdpList);
    else if (appList) base = appList;
    else if (cdpList) base = cdpList;
    else if (cdpError) throw cdpError;
    else if (appError) throw appError;
    else throw new CdpUnreachableError('ChatGPT Desktop listThreads: CDP and app-server unreachable');

    return finalizeThreadList(base, {
      limit,
      host: options.host,
      groupBy: options.groupBy,
      remotes: this.#listRemotes(),
    });
  }

  async searchThreads(options: {
    query: string;
    limit?: number;
    host?: string;
    groupBy?: 'host';
  }): Promise<ListThreadsResult> {
    const limit = options.limit ?? 50;
    try {
      const appList = await this.#fallbacks.searchThreads({
        query: options.query,
        limit,
      });
      const cdpList = await this.#tryCdpList({ limit });
      const base = cdpList ? mergeThreadLists(appList, cdpList) : appList;
      const withRemotes = finalizeThreadList(base, {
        limit: 10_000,
        host: options.host,
        remotes: this.#listRemotes(),
      });
      const needle = options.query.trim().toLowerCase();
      const filtered = {
        ...withRemotes,
        query: options.query,
        threads: withRemotes.threads.filter((thread) => threadMatchesQuery(thread, needle)),
      };
      return finalizeThreadList(filtered, {
        limit,
        host: options.host,
        groupBy: options.groupBy,
        remotes: [],
      });
    } catch (appError) {
      const cdpList = await this.#tryCdpList({ limit });
      if (!cdpList) throw appError;
      const needle = options.query.trim().toLowerCase();
      const filtered = {
        ...cdpList,
        query: options.query,
        threads: cdpList.threads.filter((thread) => threadMatchesQuery(thread, needle)),
      };
      return finalizeThreadList(filtered, {
        limit,
        host: options.host,
        groupBy: options.groupBy,
        remotes: this.#listRemotes(),
      });
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

    if (isTemporaryDesktopThreadId(options.threadId)) {
      await this.#ensureCdp();
      return this.#cdp.readThread({ ...options, limit, full });
    }

    try {
      return await this.#fallbacks.readThread({
        threadId: options.threadId,
        limit,
        full,
      });
    } catch (appError) {
      if (appError instanceof RemoteThreadNotLoadedError) throw appError;
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

  #listRemotes() {
    const list = this.#fallbacks.listRemoteThreads ?? listRemoteThreadsFromState;
    try {
      return list();
    } catch {
      return [];
    }
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
    const withLocal: ChatGptDesktopThread = {
      ...thread,
      location: thread.location ?? 'local',
      hostId: thread.hostId ?? null,
      hostName: thread.hostName ?? null,
    };
    if (!cdp) return withLocal;
    return {
      ...withLocal,
      title: withLocal.title || cdp.title,
      pinned: withLocal.pinned || cdp.pinned,
      selected: cdp.selected,
      kind: cdp.kind || withLocal.kind,
      project: cdp.project ?? withLocal.project,
    };
  });

  for (const thread of cdpList.threads) {
    if (merged.some((row) => threadIdsEquivalent(row.threadId, thread.threadId))) continue;
    merged.push({
      ...thread,
      location: thread.location ?? 'local',
      hostId: thread.hostId ?? null,
      hostName: thread.hostName ?? null,
    });
  }

  return {
    backend: appList.backend,
    limit: appList.limit,
    nextCursor: appList.nextCursor,
    ...(appList.query !== undefined ? { query: appList.query } : {}),
    threads: merged,
  };
}

/** Append remote-control summaries, apply host filter / groupBy / limit. */
export function finalizeThreadList(
  base: ListThreadsResult,
  {
    limit,
    host,
    groupBy,
    remotes,
  }: {
    limit: number;
    host?: string;
    groupBy?: 'host';
    remotes: readonly ChatGptDesktopThread[];
  },
): ListThreadsResult {
  const locals = base.threads.map((thread) => {
    const location = thread.location ?? ('local' as const);
    return {
      ...thread,
      location,
      hostId: location === 'remote' ? thread.hostId ?? null : null,
      hostName: location === 'remote' ? thread.hostName ?? null : null,
    };
  });

  const localKeys = new Set(
    locals.map((thread) => toAppServerThreadId(thread.threadId) ?? thread.threadId),
  );
  const merged: ChatGptDesktopThread[] = [...locals];
  for (const remote of remotes) {
    const key = toAppServerThreadId(remote.threadId) ?? remote.threadId;
    if (localKeys.has(key)) continue;
    merged.push({
      ...remote,
      location: remote.location ?? 'remote',
      hostId: remote.hostId ?? null,
      hostName: remote.hostName ?? null,
    });
  }

  const filtered = host
    ? merged.filter((thread) => hostMatches(thread, host))
    : merged;
  const limited = filtered.slice(0, limit);
  const result: ListThreadsResult = {
    backend: base.backend,
    limit,
    threads: limited,
    ...(base.nextCursor !== undefined ? { nextCursor: base.nextCursor } : {}),
    ...(base.query !== undefined ? { query: base.query } : {}),
    ...(host ? { host } : {}),
  };
  if (groupBy === 'host') {
    return { ...result, groupBy: 'host', groups: groupThreadsByHost(limited) };
  }
  return result;
}

export function groupThreadsByHost(
  threads: readonly ChatGptDesktopThread[],
): ChatGptDesktopHostGroup[] {
  const groups = new Map<string, ChatGptDesktopHostGroup>();
  for (const thread of threads) {
    const location = thread.location ?? 'local';
    const hostId = location === 'remote' ? thread.hostId || 'unknown-remote' : 'local';
    const key = `${location}:${hostId}`;
    const existing = groups.get(key);
    if (existing) {
      (existing.threads as ChatGptDesktopThread[]).push(thread);
      continue;
    }
    groups.set(key, {
      hostId,
      hostName: thread.hostName ?? (location === 'local' ? 'local' : null),
      location,
      threads: [thread],
    });
  }
  return [...groups.values()];
}

function hostMatches(thread: ChatGptDesktopThread, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle) return true;
  if (needle === 'local') return (thread.location ?? 'local') === 'local';
  return [thread.hostId, thread.hostName]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function threadMatchesQuery(thread: ChatGptDesktopThread, needle: string): boolean {
  if (!needle) return true;
  return [thread.title, thread.threadId, thread.project, thread.preview, thread.hostName, thread.hostId]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
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
