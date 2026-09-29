/**
 * App-server path for ChatGPT Desktop list / search / read.
 * Reuses the existing codex-bridge client — does not duplicate the WebSocket/JSON-RPC stack.
 *
 * Verified against Codex app-server 0.158.0:
 * - initialize → initialized → thread/list | thread/read | thread/turns/list | thread/items/list
 * - Do not use thread/resume for reads (it attaches a live session).
 * - includeTurns on thread/read is deprecated for paginated threads; read metadata,
 *   then page with thread/turns/list (itemsView: "full").
 *
 * Send, new-thread-in-project, wait-for-reply, and selected-thread stay on CDP (see facade).
 */

import {
  codexStatus,
  listCodexThreads,
  openCodexSession,
} from '../codex-bridge.js';
import { RemoteThreadNotLoadedError } from './errors.js';
import { findRemoteThread, findRemoteThreadHostId } from './remote-threads.js';
import {
  requireAppServerThreadId,
  toDesktopThreadId,
  toDomTurnKey,
} from './thread-ids.js';
import type {
  ChatGptDesktopThread,
  ChatGptDesktopTurn,
  ListThreadsResult,
  ReadThreadResult,
} from './types.js';

export async function appServerListThreads({
  limit = 50,
  cursor,
  modelProviders = [],
}: {
  limit?: number;
  cursor?: string;
  modelProviders?: string[];
} = {}): Promise<ListThreadsResult> {
  const out = await listCodexThreads({ limit, cursor, modelProviders });
  return {
    backend: 'app-server',
    limit: out.limit,
    nextCursor: out.nextCursor ?? null,
    threads: out.threads.map(mapListedThread),
    modelProvider: modelProviders.length === 1 ? modelProviders[0] : undefined,
  };
}

export async function appServerSearchThreads({
  query,
  limit = 50,
  modelProviders = [],
}: {
  query: string;
  limit?: number;
  modelProviders?: string[];
}): Promise<ListThreadsResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return appServerListThreads({ limit, modelProviders });
  }
  const matched: ChatGptDesktopThread[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && matched.length < limit; page++) {
    const out = await listCodexThreads({ limit: 200, cursor, modelProviders });
    for (const thread of out.threads) {
      const mapped = mapListedThread(thread);
      if (threadMatchesQuery(mapped, needle)) matched.push(mapped);
      if (matched.length >= limit) break;
    }
    if (out.nextCursor == null || typeof out.nextCursor !== 'string') break;
    cursor = out.nextCursor;
  }
  return {
    backend: 'app-server',
    limit,
    query,
    nextCursor: null,
    threads: matched.slice(0, limit),
    modelProvider: modelProviders.length === 1 ? modelProviders[0] : undefined,
  };
}

export type ModelProvidersDiscovery = {
  readonly providers: readonly string[];
  readonly source: 'thread/list-distinct';
};

/** Discover provider IDs from the supported inventory, without guessing RPCs. */
export async function discoverModelProviders(): Promise<ModelProvidersDiscovery> {
  const providers = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const out = await listCodexThreads({ limit: 200, cursor, modelProviders: [] });
    for (const thread of out.threads) {
      if (typeof thread.modelProvider === 'string' && thread.modelProvider) {
        providers.add(thread.modelProvider);
      }
    }
    if (out.nextCursor == null || typeof out.nextCursor !== 'string') break;
    cursor = out.nextCursor;
  }
  return {
    providers: [...providers].sort(),
    source: 'thread/list-distinct',
  };
}

export async function appServerReadThread({
  threadId,
  limit = 100,
  full = false,
}: {
  threadId: string;
  limit?: number;
  full?: boolean;
}): Promise<ReadThreadResult> {
  // Prefixed `local:` ids fail with `invalid thread id` — always strip first.
  const bare = requireAppServerThreadId(threadId);

  // Known remote-only threads: fail fast with a typed error + host hint.
  const remote = findRemoteThread(bare);
  if (remote) {
    // Still try local app-server in case the thread was also loaded locally.
    try {
      return await readLocalThread(bare, { limit, full });
    } catch (error) {
      if (isThreadNotLoaded(error) || isUnknownThread(error)) {
        throw new RemoteThreadNotLoadedError(bare, remote.hostId, remote.hostName);
      }
      throw maybeRemoteThreadError(error, bare);
    }
  }

  try {
    return await readLocalThread(bare, { limit, full });
  } catch (error) {
    throw maybeRemoteThreadError(error, bare);
  }
}

async function readLocalThread(
  bare: string,
  { limit, full }: { limit: number; full: boolean },
): Promise<ReadThreadResult> {
  const { client } = await openCodexSession();
  try {
    const meta = await readThreadMetadata(client, bare);
    const turns = await listTurnsFull(client, bare, { limit, full });
    return {
      threadId: toDesktopThreadId(bare),
      turns,
      backend: 'app-server',
      limit,
      full,
      title: meta.title,
      cwd: meta.cwd,
      status: meta.status,
      modelProvider: meta.modelProvider,
      model: meta.model,
    };
  } finally {
    client.close();
  }
}

export async function appServerStatusProbe(): Promise<{
  reachable: boolean;
  mode?: string;
  socketPath?: string;
}> {
  const status = (await codexStatus()) as {
    reachable?: boolean;
    mode?: string;
    socketPath?: string;
  };
  return {
    reachable: Boolean(status.reachable && status.mode === 'daemon'),
    mode: typeof status.mode === 'string' ? status.mode : undefined,
    socketPath: typeof status.socketPath === 'string' ? status.socketPath : undefined,
  };
}

type AppServerClient = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
};

type ListedThread = {
  id?: string;
  name?: string | null;
  preview?: string;
  cwd?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  section?: { id?: string; name?: string | null } | null;
  projectId?: string | null;
  status?: string;
  modelProvider?: string | null;
  model?: string | null;
  originator?: string | null;
};

function mapListedThread(thread: ListedThread): ChatGptDesktopThread {
  const bare = String(thread.id ?? '');
  const section =
    thread.section && typeof thread.section.id === 'string'
      ? { id: thread.section.id, name: thread.section.name ?? null }
      : null;
  const pinned =
    section?.id === 'Pinned' ||
    section?.name === 'Pinned' ||
    false;
  return {
    threadId: bare ? toDesktopThreadId(bare) : '',
    title: String(thread.name || thread.preview || thread.cwd || thread.id || ''),
    pinned,
    selected: false,
    kind: 'codex',
    location: 'local',
    hostId: null,
    hostName: null,
    preview: typeof thread.preview === 'string' ? thread.preview : undefined,
    cwd: thread.cwd ?? null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    section,
    projectId: thread.projectId ?? null,
    project: thread.projectId ?? undefined,
    status: thread.status,
    modelProvider: thread.modelProvider ?? null,
    model: thread.model ?? null,
    originator: thread.originator ?? null,
  };
}

function threadMatchesQuery(thread: ChatGptDesktopThread, needle: string): boolean {
  const haystacks = [
    thread.threadId,
    thread.title,
    thread.preview,
    thread.cwd,
    thread.project,
    thread.projectId,
    thread.model,
    thread.modelProvider,
    thread.originator,
    thread.section?.name,
    thread.section?.id,
  ];
  return haystacks.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

async function readThreadMetadata(
  client: AppServerClient,
  threadId: string,
): Promise<{
  title?: string;
  cwd?: string | null;
  status?: string;
  modelProvider?: string | null;
  model?: string | null;
}> {
  try {
    // Metadata only — includeTurns is deprecated for paginated threads.
    const read = await client.request('thread/read', { threadId }) as {
      thread?: Record<string, unknown>;
    };
    const thread = read.thread && typeof read.thread === 'object' ? read.thread : {};
    const statusObj = thread.status;
    const statusType =
      statusObj && typeof statusObj === 'object' && typeof (statusObj as { type?: unknown }).type === 'string'
        ? String((statusObj as { type: string }).type)
        : typeof thread.status === 'string'
          ? thread.status
          : undefined;
    return {
      title:
        typeof thread.name === 'string'
          ? thread.name
          : typeof thread.preview === 'string'
            ? thread.preview
            : undefined,
      cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
      status: statusType,
      modelProvider: typeof thread.modelProvider === 'string' ? thread.modelProvider : null,
      model: typeof thread.model === 'string' ? thread.model : null,
    };
  } catch (error) {
    throw maybeRemoteThreadError(error, threadId);
  }
}

async function listTurnsFull(
  client: AppServerClient,
  threadId: string,
  { limit, full }: { limit: number; full: boolean },
): Promise<ChatGptDesktopTurn[]> {
  const collected: unknown[] = [];
  let cursor: string | undefined;
  let itemsView = true;
  let method = 'thread/turns/list';
  const seen = new Set<string>();
  while (collected.length < limit) {
    let result: { data?: unknown[]; nextCursor?: string | null };
    try {
      result = await client.request(method, {
        threadId,
        limit: Math.min(100, limit - collected.length),
        sortDirection: full ? 'asc' : 'desc',
        ...(method === 'thread/turns/list' && itemsView ? { itemsView: 'full' } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }) as typeof result;
    } catch (error) {
      const code = (error as { rpc?: { code?: number } })?.rpc?.code;
      if (collected.length === 0 && code === -32602 && itemsView) {
        itemsView = false;
        continue;
      }
      if (collected.length === 0 && code === -32601 && method === 'thread/turns/list') {
        method = 'thread/items/list';
        continue;
      }
      throw maybeRemoteThreadError(error, threadId);
    }
    if (!Array.isArray(result?.data)) throw new Error(`${method} missing data array for ${threadId}`);
    collected.push(...result.data);
    if (result.nextCursor == null) break;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) {
      throw new Error(`${method} returned an invalid or repeated cursor`);
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  const turns = normalizeTurns(collected.slice(0, limit));
  return full ? turns : turns.reverse();
}

function normalizeTurns(raw: unknown[]): ChatGptDesktopTurn[] {
  const turns: ChatGptDesktopTurn[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? row.turnId ?? index);
    const items = Array.isArray(row.items) ? row.items : null;
    if (items) {
      turns.push(normalizeTurnWithItems(id, row, items));
      continue;
    }
    turns.push(normalizeLeafItem(id, row));
  }
  return turns;
}

function normalizeTurnWithItems(
  id: string,
  row: Record<string, unknown>,
  items: unknown[],
): ChatGptDesktopTurn {
  let userText = '';
  let assistantText = '';
  let toolText = '';
  let reasoningText = '';
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const type = String(item.type ?? item.role ?? '');
    const text = extractText(item);
    if (/user/i.test(type)) userText = joinText(userText, text);
    else if (/agent|assistant|message/i.test(type) && !/reasoning|tool/i.test(type)) {
      assistantText = joinText(assistantText, text);
    } else if (/tool/i.test(type)) toolText = joinText(toolText, text || type);
    else if (/reasoning/i.test(type)) reasoningText = joinText(reasoningText, text);
  }
  let role: ChatGptDesktopTurn['role'] = 'assistant';
  let text = assistantText || userText;
  if (userText && !assistantText) {
    role = 'user';
    text = userText;
  } else if (!userText && !assistantText && toolText) {
    role = 'tool';
    text = toolText;
  } else if (!userText && !assistantText && reasoningText) {
    role = 'reasoning';
    text = reasoningText;
  }
  return {
    turnKey: toDomTurnKey(id),
    role,
    text,
    ...(userText ? { userText } : {}),
    ...(assistantText ? { assistantText } : {}),
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : null,
    endedAt: typeof row.endedAt === 'number' ? row.endedAt : null,
  };
}

function normalizeLeafItem(id: string, row: Record<string, unknown>): ChatGptDesktopTurn {
  const text = extractText(row);
  const type = String(row.type ?? row.role ?? '');
  let role: ChatGptDesktopTurn['role'] = 'assistant';
  if (/user/i.test(type)) role = 'user';
  else if (/tool/i.test(type)) role = 'tool';
  else if (/reasoning/i.test(type)) role = 'reasoning';
  else if (/status|system/i.test(type) && !text) role = 'status';
  return {
    turnKey: toDomTurnKey(id),
    role,
    text,
    startedAt: typeof row.startedAt === 'number' ? row.startedAt : null,
    endedAt: typeof row.endedAt === 'number' ? row.endedAt : null,
  };
}

function extractText(row: Record<string, unknown>): string {
  if (typeof row.text === 'string') return row.text;
  if (typeof row.content === 'string') return row.content;
  if (typeof row.preview === 'string') return row.preview;
  return '';
}

function joinText(left: string, right: string): string {
  if (!right) return left;
  if (!left) return right;
  return `${left}\n${right}`;
}

function isThreadNotLoaded(error: unknown): boolean {
  const message = errorMessage(error);
  return /thread not loaded|not loaded|invalid thread id/i.test(message);
}

function isUnknownThread(error: unknown): boolean {
  const message = errorMessage(error);
  return /no rollout found|thread not found|unknown.*thread/i.test(message);
}

function maybeRemoteThreadError(error: unknown, threadId: string): Error {
  const message = errorMessage(error);
  if (/thread not loaded|not loaded|no rollout found|thread not found/i.test(message)) {
    const remote = findRemoteThread(threadId);
    if (remote) {
      return new RemoteThreadNotLoadedError(threadId, remote.hostId, remote.hostName);
    }
    const hostId = findRemoteThreadHostId(threadId);
    return new RemoteThreadNotLoadedError(threadId, hostId, null);
  }
  if (error instanceof Error) return error;
  return new Error(message || `app-server error for thread ${threadId}`);
}

function errorMessage(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  if (typeof error === 'object' && error && 'rpc' in error) {
    const rpc = (error as { rpc?: { message?: unknown } }).rpc;
    if (rpc && typeof rpc.message === 'string') return rpc.message;
  }
  return String(error);
}
