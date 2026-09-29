/**
 * App-server path for ChatGPT Desktop list/deep-read/open.
 * Reuses the existing codex-bridge client — does not duplicate the WebSocket/JSON-RPC stack.
 *
 * Send, new-thread-in-project, and wait-for-reply stay on CDP (see facade).
 */

import {
  codexStatus,
  listCodexThreads,
  openCodexSession,
} from '../codex-bridge.js';
import {
  appServerThreadIdCandidates,
  toDesktopThreadId,
} from './thread-ids.js';
import type {
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
} from './types.js';

export async function appServerListThreads({
  limit = 50,
}: {
  limit?: number;
} = {}): Promise<ListThreadsResult> {
  const out = await listCodexThreads({ limit });
  return {
    backend: 'app-server',
    limit: out.limit,
    threads: out.threads.map((thread: {
      id?: string;
      name?: string;
      preview?: string;
      cwd?: string;
    }) => {
      const bare = String(thread.id ?? '');
      return {
        // Present Desktop-form ids so callers can pass them straight back to read/send.
        threadId: bare ? toDesktopThreadId(bare) : '',
        title: String(thread.name || thread.preview || thread.cwd || thread.id || ''),
        pinned: false,
        selected: false,
        kind: 'codex',
      };
    }),
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
  const candidates = appServerThreadIdCandidates(threadId);
  if (candidates.length === 0) {
    throw new Error(
      `No app-server thread id mapping for ${threadId} (temporary Desktop rows need CDP)`,
    );
  }

  const { client } = await openCodexSession();
  try {
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const turns = await readTurnsForId(client, candidate, { limit, full });
        return {
          threadId: toDesktopThreadId(candidate),
          turns,
          backend: 'app-server',
          limit,
          full,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`app-server thread read failed for ${threadId}`);
  } finally {
    client.close();
  }
}

export async function appServerOpenThread(threadId: string): Promise<OpenThreadResult> {
  const candidates = appServerThreadIdCandidates(threadId);
  if (candidates.length === 0) {
    throw new Error(
      `No app-server thread id mapping for ${threadId} (temporary Desktop rows need CDP)`,
    );
  }
  const { client } = await openCodexSession();
  try {
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await client.request('thread/resume', { threadId: candidate, excludeTurns: true });
        return { threadId: toDesktopThreadId(candidate), backend: 'app-server' };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`app-server thread/resume failed for ${threadId}`);
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

async function readTurnsForId(
  client: AppServerClient,
  threadId: string,
  { limit, full }: { limit: number; full: boolean },
): Promise<ReadThreadResult['turns']> {
  // Prefer thread/read (full history inspection). Fall back to resume-with-turns,
  // then paginated turns/items lists — same client, no duplicated transport.
  try {
    const read = await client.request('thread/read', { threadId }) as {
      thread?: { turns?: unknown[]; items?: unknown[] };
      turns?: unknown[];
      items?: unknown[];
    };
    const raw = read.thread?.turns ?? read.turns ?? read.thread?.items ?? read.items ?? [];
    if (Array.isArray(raw) && raw.length > 0) {
      return sliceTurns(normalizeTurns(raw), { limit, full });
    }
  } catch {
    // try resume / list below
  }

  try {
    const resumed = await client.request('thread/resume', {
      threadId,
      excludeTurns: false,
    }) as {
      thread?: { turns?: unknown[]; items?: unknown[] };
      turns?: unknown[];
    };
    const raw = resumed.thread?.turns ?? resumed.turns ?? resumed.thread?.items ?? [];
    if (Array.isArray(raw) && raw.length > 0) {
      return sliceTurns(normalizeTurns(raw), { limit, full });
    }
  } catch {
    // try list below
  }

  for (const method of ['thread/turns/list', 'thread/items/list'] as const) {
    try {
      const collected: unknown[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await client.request(method, {
          threadId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }) as { data?: unknown[]; nextCursor?: string | null };
        if (!Array.isArray(result.data)) break;
        collected.push(...result.data);
        if (result.nextCursor == null || typeof result.nextCursor !== 'string') break;
        cursor = result.nextCursor;
        if (!full && collected.length >= limit) break;
      }
      if (collected.length > 0) {
        return sliceTurns(normalizeTurns(collected), { limit, full });
      }
    } catch {
      // try next method
    }
  }

  throw new Error(`app-server has no turn history for thread ${threadId}`);
}

function sliceTurns(
  turns: ReadThreadResult['turns'],
  { limit, full }: { limit: number; full: boolean },
): ReadThreadResult['turns'] {
  if (limit <= 0) return turns;
  if (full) return turns.slice(0, limit);
  return turns.slice(-limit);
}

function normalizeTurns(raw: unknown[]): ReadThreadResult['turns'] {
  const turns: Array<ReadThreadResult['turns'][number]> = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const text =
      typeof row.text === 'string'
        ? row.text
        : typeof row.content === 'string'
          ? row.content
          : '';
    const type = String(row.type ?? row.role ?? '');
    let role: 'user' | 'assistant' | 'status' = 'assistant';
    if (/user/i.test(type)) role = 'user';
    else if (/status|system|reasoning/i.test(type) && !text) role = 'status';
    turns.push({
      turnKey: String(row.id ?? row.turnId ?? index),
      role,
      text,
    });
  }
  return turns;
}
