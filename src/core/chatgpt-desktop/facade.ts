import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerReadThread,
  appServerUnarchiveThread,
  appServerSearchThreads,
  appServerStatusProbe,
  discoverModelProviders,
} from './app-server-fallback.js';
import { ArchivedThreadError, CdpUnreachableError, NotImplementedError, RemoteThreadNotLoadedError } from './errors.js';
import { resolveCdpPort } from './loopback.js';
import { findRemoteThread, listDiscoveredHosts, listRemoteThreadsFromState } from './remote-threads.js';
import { compactThreadRow, compactThreadTitle, DESKTOP_RESULT_BUDGET_BYTES, serializedBytes } from './payload-budget.js';
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
  unarchiveThread?: typeof appServerUnarchiveThread;
  statusProbe: typeof appServerStatusProbe;
  listRemoteThreads?: typeof listRemoteThreadsFromState;
  listHosts?: typeof listDiscoveredHosts;
  discoverModelProviders?: typeof discoverModelProviders;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  searchThreads: appServerSearchThreads,
  readThread: appServerReadThread,
  unarchiveThread: appServerUnarchiveThread,
  statusProbe: appServerStatusProbe,
  listRemoteThreads: listRemoteThreadsFromState,
  listHosts: listDiscoveredHosts,
  discoverModelProviders,
};

const REMOTE_PAGE_CURSOR = 'desktop-remote-page:';
const APP_START_CURSOR = 'desktop-app-start';

export type ListThreadsOptions = {
  limit?: number;
  cursor?: string;
  /**
   * Any string (not an enum). Reserved: `all` (default), `local`. Otherwise a
   * hostId or friendly name discovered at runtime — see `listHosts` /
   * `chatgpt_desktop_list_hosts`. New machines appear with no code change.
   */
  host?: string;
  /**
   * Any modelProvider id string (not an enum). Passed through to app-server
   * `thread/list` as `modelProviders`. Omit / empty = all. Discovered values:
   * see `listHosts` / `chatgpt_desktop_list_hosts`.
   */
  modelProvider?: string;
  /** Match a Desktop project label or app-server projectId. */
  project?: string;
  /** When `"host"`, also return `groups` keyed by host (grouping mode). */
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
    const remoteOffset = options.cursor?.startsWith(REMOTE_PAGE_CURSOR)
      ? Number(options.cursor.slice(REMOTE_PAGE_CURSOR.length)) : null;
    if (remoteOffset !== null && (!Number.isSafeInteger(remoteOffset) || remoteOffset < 1)) {
      throw new Error('Invalid ChatGPT Desktop remote page cursor');
    }
    const inventoryPage = !options.cursor || remoteOffset !== null;
    const remotes = inventoryPage ? this.#listRemotes() : [];
    let cdpList: ListThreadsResult | null = null;
    let cdpError: unknown;
    try {
      if (inventoryPage) {
        await this.#ensureCdp();
        cdpList = await this.#cdp.listThreads({ limit: 200 });
      }
    } catch (error) {
      if (isCdpFailure(error)) {
        this.#cdpConnected = false;
      } else {
        cdpError = error;
      }
    }

    if (inventoryPage && host !== 'local') {
      const remoteInventory = finalizeThreadList({
        backend: cdpList?.backend ?? 'remote-state', limit: 10_000,
        threads: cdpList?.threads.filter((thread) => thread.location === 'remote') ?? [],
      }, { limit: 10_000, host, modelProvider: options.modelProvider, project: options.project, remotes });
      const offset = remoteOffset ?? 0;
      if (remoteOffset !== null || remoteInventory.threads.length >= limit) {
        const page: ChatGptDesktopThread[] = [];
        for (const thread of remoteInventory.threads.slice(offset, offset + limit)) {
          const row = compactThreadRow(thread);
          if (serializedBytes({ ...remoteInventory, threads: [...page, row], nextCursor: REMOTE_PAGE_CURSOR,
            ...(options.groupBy === 'host' ? { groups: groupThreadsByHost([...page, row]) } : {}) }) > DESKTOP_RESULT_BUDGET_BYTES) {
            if (!page.length) throw new Error('ChatGPT Desktop remote thread row exceeds the MCP result byte budget');
            break;
          }
          page.push(row);
        }
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < remoteInventory.threads.length
          ? `${REMOTE_PAGE_CURSOR}${nextOffset}` : host === 'all' ? APP_START_CURSOR : null;
        return { ...remoteInventory, threads: page, limit, nextCursor,
          ...(options.groupBy === 'host' ? { groupBy: 'host', groups: groupThreadsByHost(page) } : {}) };
      }
    }

    const remoteKeys = new Set(remotes.map((thread) => toAppServerThreadId(thread.threadId) ?? thread.threadId));
    const reservedRemoteRows = host === 'all' && inventoryPage
      ? remotes.filter((thread) => modelProviderMatches(thread, options.modelProvider)
        && projectMatches(thread, options.project)).length
        + (cdpList?.threads.filter((thread) => thread.location === 'remote'
          && modelProviderMatches(thread, options.modelProvider)
          && projectMatches(thread, options.project)
          && !remoteKeys.has(toAppServerThreadId(thread.threadId) ?? thread.threadId)).length ?? 0)
      : 0;
    const appLimit = Math.max(1, limit - Math.min(limit - 1, reservedRemoteRows));
    let appList: ListThreadsResult | null = null;
    let appError: unknown;
    try {
      appList = await this.#fallbacks.listThreads({ limit: appLimit,
        cursor: options.cursor === APP_START_CURSOR ? undefined : options.cursor, modelProviders });
    } catch (error) {
      appError = error;
    }

    let base: ListThreadsResult | null = null;
    if (appList && cdpList) base = mergeThreadLists(appList, cdpList);
    else if (appList) base = appList;
    else if (cdpList) base = cdpList;
    else if (remotes.length) base = { backend: 'remote-state', limit, threads: [] };
    else if (cdpError) throw cdpError;
    else if (appError) throw appError;
    else throw new CdpUnreachableError('ChatGPT Desktop listThreads: CDP and app-server unreachable');

    const result = finalizeThreadList(base, {
      limit,
      host,
      modelProvider: options.modelProvider?.trim() || undefined,
      project: options.project,
      groupBy: options.groupBy,
      remotes,
    });
    const withCursor = host === 'all' || host === 'local' ? result : { ...result, nextCursor: null };
    return appError ? { ...withCursor, warnings: [`App-server list failed: ${appError instanceof Error ? appError.message : String(appError)}`] } : withCursor;
  }

  async listHosts(): Promise<ListHostsResult> {
    const remotes = this.#listRemotes();
    const cdpRows = typeof this.#cdp.listThreads === 'function'
      ? (await this.#tryCdpList({ limit: 200 }))?.threads ?? [] : [];
    let localThreadCount = 0;
    try {
      const local = await this.#fallbacks.listThreads({ limit: 25, modelProviders: [] });
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

    for (const thread of cdpRows) {
      if (thread.location !== 'remote' || !thread.hostId) continue;
      if (!byId.has(thread.hostId)) byId.set(thread.hostId, {
        hostId: thread.hostId, hostName: thread.hostName ?? null, location: 'remote', threadCount: 0,
      });
    }

    const hostsSource = 'local+remote-thread-summaries-v3+managed-connections'
      + (cdpRows.length ? '+cdp' : '');

    // Recount remotes from the parsed summary rows for accuracy.
    const remoteCounts = new Map<string, number>();
    const remoteInventory = finalizeThreadList({
      backend: cdpRows.length ? 'cdp' : 'remote-state', limit: 10_000,
      threads: cdpRows.filter((thread) => thread.location === 'remote'),
    }, { limit: 10_000, remotes });
    for (const thread of remoteInventory.threads) {
      if (thread.hostId) remoteCounts.set(thread.hostId, (remoteCounts.get(thread.hostId) ?? 0) + 1);
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
    const warnings: string[] = [];
    try {
      const discover = this.#fallbacks.discoverModelProviders ?? discoverModelProviders;
      const discovered = await discover();
      modelProviders = [...discovered.providers];
      modelProvidersSource = discovered.source;
      if (typeof discovered.threadCount === 'number') localThreadCount = discovered.threadCount;
      if (discovered.complete === false) warnings.push('Provider discovery stopped before the final app-server page');
    } catch (error) {
      warnings.push(`Model provider discovery failed: ${error instanceof Error ? error.message : String(error)}`);
      modelProviders = [...new Set(
        remotes
          .map((thread) => thread.modelProvider)
          .filter((value): value is string => typeof value === 'string' && Boolean(value)),
      )].sort();
      modelProvidersSource = 'remote-summaries-distinct';
    }
    modelProviders = [...new Set([
      ...modelProviders,
      ...remotes.map((thread) => thread.modelProvider).filter((value): value is string => Boolean(value)),
    ])].sort();
    return {
      hosts: withCounts.map((host) => {
        const counted = host.hostId === 'local' ? { ...host, threadCount: localThreadCount } : host;
        if (!counted.hostName) return counted;
        const name = compactThreadTitle(counted.hostName);
        return { ...counted, hostName: name.title,
          ...(name.titleTruncated ? { hostNameTruncated: true } : {}) };
      }),
      hostsSource,
      modelProviders,
      modelProvidersSource,
      backend: cdpRows.length
        ? (remotes.length ? 'app-server+cdp+remote-state' : 'app-server+cdp')
        : (remotes.length ? 'app-server+remote-state' : 'app-server'),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  async searchThreads(options: {
    query: string;
    limit?: number;
    cursor?: string;
    host?: string;
    modelProvider?: string;
    project?: string;
    groupBy?: 'host';
  }): Promise<ListThreadsResult> {
    const limit = options.limit ?? 50;
    const host = normalizeHostFilter(options.host);
    const modelProviders = modelProvidersFromFilter(options.modelProvider);
    try {
      const appList = await this.#fallbacks.searchThreads({
        query: options.query,
        limit,
        cursor: options.cursor,
        modelProviders,
        project: options.project,
      });
      const cdpList = options.cursor ? null : await this.#tryCdpList({ limit });
      const base = cdpList ? mergeThreadLists(appList, cdpList) : appList;
      const appMatches = new Set(appList.threads.map((thread) => thread.threadId));
      const withRemotes = finalizeThreadList(base, {
        limit: 10_000,
        host,
        modelProvider: options.modelProvider?.trim() || undefined,
        project: options.project,
        remotes: options.cursor ? [] : this.#listRemotes(),
      });
      const needle = options.query.trim().toLowerCase();
      const filtered = {
        ...withRemotes,
        query: options.query,
        threads: withRemotes.threads.filter((thread) => appMatches.has(thread.threadId) || threadMatchesQuery(thread, needle)),
      };
      const result = finalizeThreadList(filtered, {
        limit,
        host,
        modelProvider: options.modelProvider?.trim() || undefined,
        project: options.project,
        groupBy: options.groupBy,
        remotes: [],
      });
      return result;
    } catch (appError) {
      if (options.cursor) throw appError;
      const cdpList = await this.#tryCdpList({ limit });
      const remotes = this.#listRemotes();
      if (!cdpList && !remotes.length) throw appError;
      const needle = options.query.trim().toLowerCase();
      const filtered = {
        ...(cdpList ?? { backend: 'app-server' as const, limit }),
        query: options.query,
        threads: (cdpList?.threads ?? []).filter((thread) => threadMatchesQuery(thread, needle)),
      };
      const result = finalizeThreadList(filtered, {
        limit,
        host,
        modelProvider: options.modelProvider?.trim() || undefined,
        project: options.project,
        groupBy: options.groupBy,
        remotes: remotes.filter((thread) => threadMatchesQuery(thread, needle)),
      });
      return { ...result, warnings: [`App-server search failed: ${appError instanceof Error ? appError.message : String(appError)}`] };
    }
  }

  async readThread(options: {
    threadId: string;
    limit?: number;
    full?: boolean;
    cursor?: string;
    openTimeoutMs?: number;
  }): Promise<ReadThreadResult> {
    const limit = options.limit ?? (options.full ? 2000 : 100);
    const full = options.full ?? false;

    if (isTemporaryDesktopThreadId(options.threadId)) {
      if (options.cursor) throw new Error('Temporary Desktop threads do not support read cursors');
      await this.#ensureCdp();
      return this.#cdp.readThread({ ...options, limit, full });
    }

    try {
      return await this.#fallbacks.readThread({
        threadId: options.threadId,
        limit,
        full,
        cursor: options.cursor,
      });
    } catch (appError) {
      if (appError instanceof RemoteThreadNotLoadedError) throw appError;
      if (options.cursor) throw appError;
      const cdpConnected = await this.#tryEnsureCdp();
      if (!cdpConnected) throw appError;
      const fallback = await this.#cdp.readThread({ ...options, limit, full });
      return { ...fallback, complete: false, warnings: [`App-server read failed: ${appError instanceof Error ? appError.message : String(appError)}`] };
    }
  }

  async sendMessage(options: {
    threadId?: string;
    text: string;
    project?: string;
    unarchive?: boolean;
    openTimeoutMs?: number;
  }): Promise<SendMessageResult> {
    if (options.threadId) {
      const remote = findRemoteThread(options.threadId);
      if (remote) throw new RemoteThreadNotLoadedError(options.threadId, remote.hostId, remote.hostName);
    }
    await this.#ensureCdp();
    try {
      return await this.#cdp.sendMessage(options);
    } catch (error) {
      if (!(error instanceof ArchivedThreadError) || !options.unarchive || !options.threadId) throw error;
      await (this.#fallbacks.unarchiveThread ?? appServerUnarchiveThread)(options.threadId);
      return this.#cdp.sendMessage({ ...options, unarchive: false });
    }
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
    const remote = findRemoteThread(threadId);
    if (remote) throw new RemoteThreadNotLoadedError(threadId, remote.hostId, remote.hostName);
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
    const reachable = cdpStatus.reachable;
    return {
      ...cdpStatus,
      port: this.#port,
      appServerFallback,
      reachable,
      message: cdpStatus.reachable
        ? cdpStatus.message
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
      location: cdp.location === 'remote' ? 'remote' : withLocal.location,
      hostId: cdp.location === 'remote' ? cdp.hostId ?? null : withLocal.hostId,
      hostName: cdp.location === 'remote' ? cdp.hostName ?? null : withLocal.hostName,
    };
  });

  for (const thread of cdpList.threads) {
    if (merged.some((row) => threadIdsEquivalent(row.threadId, thread.threadId))) continue;
    merged.push(thread);
  }

  return {
    backend: 'app-server+cdp',
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
    project,
    groupBy,
    remotes,
  }: {
    limit: number;
    host?: string;
    modelProvider?: string;
    project?: string;
    groupBy?: 'host';
    remotes: readonly ChatGptDesktopThread[];
  },
): ListThreadsResult {
  const remoteById = new Map(remotes.map((thread) => [
    toAppServerThreadId(thread.threadId) ?? thread.threadId, thread,
  ]));
  const locals = base.threads.map((thread) => {
    const remote = remoteById.get(toAppServerThreadId(thread.threadId) ?? thread.threadId);
    if (remote) {
      return { ...thread, ...remote, selected: thread.selected, pinned: thread.pinned || remote.pinned };
    }
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
  if (remotes.length) merged.sort((a, b) => Number(b.location === 'remote') - Number(a.location === 'remote'));

  const filtered = merged.filter((thread) => {
    if (!hostMatches(thread, host)) return false;
    if (!modelProviderMatches(thread, modelProvider)) return false;
    if (!projectMatches(thread, project)) return false;
    return true;
  });
  const limited = filtered.slice(0, limit).map(compactThreadRow);
  const result: ListThreadsResult = {
    backend: remotes.length
      ? (base.backend === 'app-server+cdp' ? 'app-server+cdp+remote-state'
        : base.backend === 'app-server' ? 'app-server+remote-state'
        : base.backend === 'cdp' ? 'cdp+remote-state' : base.backend)
      : base.backend,
    limit,
    threads: limited,
    ...(base.nextCursor !== undefined ? { nextCursor: base.nextCursor } : {}),
    ...(base.query !== undefined ? { query: base.query } : {}),
    host,
    ...(modelProvider ? { modelProvider } : {}),
    ...(project ? { project } : {}),
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
  return thread.modelProvider === modelProvider;
}

function projectMatches(thread: ChatGptDesktopThread, project?: string): boolean {
  if (!project) return true;
  const needle = project.trim().toLowerCase();
  return [thread.project, thread.projectId].some((value) =>
    typeof value === 'string' && value.toLowerCase().includes(needle));
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
