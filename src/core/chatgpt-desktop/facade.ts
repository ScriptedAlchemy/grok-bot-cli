import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerReadThread,
  appServerSearchThreads,
  appServerStatusProbe,
  discoverModelProviders,
  discoverRemoteEnvironments,
} from './app-server-fallback.js';
import { CdpUnreachableError, NotImplementedError, RemoteThreadNotLoadedError } from './errors.js';
import { resolveCdpPort } from './loopback.js';
import { listDiscoveredHosts, listRemoteThreadsFromState } from './remote-threads.js';
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
  ListHostsResult,
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
  listHosts?: typeof listDiscoveredHosts;
  discoverModelProviders?: typeof discoverModelProviders;
  discoverRemoteEnvironments?: typeof discoverRemoteEnvironments;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  searchThreads: appServerSearchThreads,
  readThread: appServerReadThread,
  statusProbe: appServerStatusProbe,
  listRemoteThreads: listRemoteThreadsFromState,
  listHosts: listDiscoveredHosts,
  discoverModelProviders,
  discoverRemoteEnvironments,
};

export type ListThreadsOptions = {
  limit?: number;
  /**
   * Machine / location filter discovered from remote summaries + `local`.
   * `all` (default) | `local` | `<hostId or friendly name>`.
   */
  host?: string;
  /**
   * Passed through to app-server `thread/list` as `modelProviders`.
   * Omit / empty = all providers (`modelProviders: []`).
   */
  modelProvider?: string;
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
    const host = normalizeHostFilter(options.host);
    const modelProviders = modelProvidersFromFilter(options.modelProvider);
    let appList: ListThreadsResult | null = null;
    let appError: unknown;
    try {
      appList = await this.#fallbacks.listThreads({ limit, modelProviders });
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
      host,
      modelProvider: options.modelProvider,
      groupBy: options.groupBy,
      remotes: this.#listRemotes(),
    });
  }

  async listHosts(): Promise<ListHostsResult> {
    const remotes = this.#listRemotes();
    let localThreadCount = 0;
    try {
      const local = await this.#fallbacks.listThreads({ limit: 200, modelProviders: [] });
      localThreadCount = local.threads.length;
    } catch {
      localThreadCount = 0;
    }
    const listHosts = this.#fallbacks.listHosts ?? listDiscoveredHosts;
    const fromState = listHosts(process.env, { localThreadCount });
    const byId = new Map(fromState.map((host) => [host.hostId, { ...host }]));

    // Ensure every host seen in merged remotes is present (tests / custom
    // listRemoteThreads may supply rows without a matching global-state file).
    for (const thread of remotes) {
      const existing = byId.get(thread.hostId);
      if (existing) {
        byId.set(thread.hostId, {
          ...existing,
          hostName: existing.hostName ?? thread.hostName,
        });
      } else {
        byId.set(thread.hostId, {
          hostId: thread.hostId,
          hostName: thread.hostName,
          location: 'remote',
          threadCount: 0,
        });
      }
    }

    let hostsSource = 'remote-thread-summaries-v3+local';
    try {
      const discoverEnvs =
        this.#fallbacks.discoverRemoteEnvironments ?? discoverRemoteEnvironments;
      const appHosts = await discoverEnvs();
      if (appHosts.source && appHosts.hosts.length > 0) {
        for (const host of appHosts.hosts) {
          const existing = byId.get(host.hostId);
          if (existing) {
            byId.set(host.hostId, {
              ...existing,
              hostName: existing.hostName ?? host.hostName,
            });
          } else {
            byId.set(host.hostId, {
              hostId: host.hostId,
              hostName: host.hostName,
              location: 'remote',
              threadCount: 0,
            });
          }
        }
        hostsSource = `${appHosts.source}+remote-thread-summaries-v3+local`;
      }
    } catch {
      // App-server remote-env probe unavailable — keep global-state hosts.
    }

    // Recount remotes from the parsed summary rows for accuracy.
    const remoteCounts = new Map<string, number>();
    for (const thread of remotes) {
      remoteCounts.set(thread.hostId, (remoteCounts.get(thread.hostId) ?? 0) + 1);
    }
    const withCounts = [...byId.values()]
      .map((host) =>
        host.hostId === 'local'
          ? { ...host, threadCount: localThreadCount }
          : { ...host, threadCount: remoteCounts.get(host.hostId) ?? host.threadCount },
      )
      .sort((a, b) => {
        if (a.hostId === 'local') return -1;
        if (b.hostId === 'local') return 1;
        return a.hostId.localeCompare(b.hostId);
      });

    let modelProviders: string[] = [];
    let modelProvidersSource = 'thread/list-distinct';
    try {
      const discover = this.#fallbacks.discoverModelProviders ?? discoverModelProviders;
      const discovered = await discover();
      modelProviders = [...discovered.providers];
      modelProvidersSource = discovered.source;
    } catch {
      modelProviders = [...new Set(
        remotes
          .map((thread) => thread.modelProvider)
          .filter((value): value is string => typeof value === 'string' && Boolean(value)),
      )].sort();
      modelProvidersSource = 'remote-summaries-distinct';
    }
    return {
      hosts: withCounts,
      hostsSource,
      modelProviders,
      modelProvidersSource,
      backend: 'app-server',
    };
  }

  async searchThreads(options: {
    query: string;
    limit?: number;
    host?: string;
    modelProvider?: string;
    groupBy?: 'host';
  }): Promise<ListThreadsResult> {
    const limit = options.limit ?? 50;
    const host = normalizeHostFilter(options.host);
    const modelProviders = modelProvidersFromFilter(options.modelProvider);
    try {
      const appList = await this.#fallbacks.searchThreads({
        query: options.query,
        limit,
        modelProviders,
      });
      const cdpList = await this.#tryCdpList({ limit });
      const base = cdpList ? mergeThreadLists(appList, cdpList) : appList;
      const withRemotes = finalizeThreadList(base, {
        limit: 10_000,
        host,
        modelProvider: options.modelProvider,
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
        host,
        modelProvider: options.modelProvider,
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
        host,
        modelProvider: options.modelProvider,
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
    host = 'all',
    modelProvider,
    groupBy,
    remotes,
  }: {
    limit: number;
    host?: string;
    modelProvider?: string;
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

  const filtered = merged.filter((thread) => {
    if (!hostMatches(thread, host)) return false;
    if (!modelProviderMatches(thread, modelProvider)) return false;
    return true;
  });
  const limited = filtered.slice(0, limit);
  const result: ListThreadsResult = {
    backend: base.backend,
    limit,
    threads: limited,
    ...(base.nextCursor !== undefined ? { nextCursor: base.nextCursor } : {}),
    ...(base.query !== undefined ? { query: base.query } : {}),
    host,
    ...(modelProvider ? { modelProvider } : {}),
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

function normalizeHostFilter(host?: string): string {
  const value = (host ?? 'all').trim();
  return value || 'all';
}

function modelProvidersFromFilter(modelProvider?: string): string[] {
  if (!modelProvider || !modelProvider.trim()) return [];
  return [modelProvider.trim()];
}

function hostMatches(thread: ChatGptDesktopThread, host: string): boolean {
  const needle = host.trim().toLowerCase();
  if (!needle || needle === 'all') return true;
  if (needle === 'local') return (thread.location ?? 'local') === 'local';
  return [thread.hostId, thread.hostName]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function modelProviderMatches(thread: ChatGptDesktopThread, modelProvider?: string): boolean {
  if (!modelProvider) return true;
  if (!thread.modelProvider) {
    // Remote summaries often omit provider — keep them; local rows from a
    // filtered thread/list already match the server-side modelProviders filter.
    return thread.location === 'remote';
  }
  return thread.modelProvider === modelProvider;
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
