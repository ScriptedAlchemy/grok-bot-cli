/**
 * App-server fallback for ChatGPT Desktop operations that also exist on the
 * managed Codex daemon. Reuses the existing codex-bridge client — does not
 * duplicate the WebSocket/JSON-RPC stack.
 */

import {
  codexStatus,
  listCodexThreads,
  openCodexSession,
  sendToCodexThread,
} from '../codex-bridge.js';
import type {
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
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
    }) => ({
      threadId: String(thread.id ?? ''),
      title: String(thread.name || thread.preview || thread.cwd || thread.id || ''),
      pinned: false,
      selected: false,
      kind: 'codex',
    })),
  };
}

export async function appServerReadThread({
  threadId,
  limit = 100,
}: {
  threadId: string;
  limit?: number;
}): Promise<ReadThreadResult> {
  const { client } = await openCodexSession();
  try {
    // Prefer thread/read when the daemon supports it; fall back to items list.
    let turns: ReadThreadResult['turns'] = [];
    try {
      const read = await client.request('thread/read', { threadId }) as {
        thread?: { turns?: unknown[]; items?: unknown[] };
        turns?: unknown[];
        items?: unknown[];
      };
      const raw = read.thread?.turns ?? read.turns ?? read.thread?.items ?? read.items ?? [];
      turns = normalizeTurns(raw).slice(-limit);
    } catch {
      const items = await client.request('thread/items/list', {
        threadId,
        limit: Math.min(limit, 100),
      }) as { data?: unknown[] };
      turns = normalizeTurns(items.data ?? []).slice(-limit);
    }
    return { threadId, turns, backend: 'app-server', limit };
  } finally {
    client.close();
  }
}

export async function appServerSendMessage({
  threadId,
  text,
}: {
  threadId?: string;
  text: string;
}): Promise<SendMessageResult> {
  if (!threadId) {
    return {
      threadId: 'new',
      backend: 'app-server',
      experimental: false,
      delivery: 'rejected',
      message:
        'app-server fallback requires an existing threadId; starting a new Desktop thread needs CDP',
    };
  }
  const receipt = await sendToCodexThread(threadId, text);
  return {
    threadId,
    backend: 'app-server',
    experimental: false,
    delivery: (receipt.delivery as SendMessageResult['delivery']) ?? 'accepted',
    message: typeof receipt.turnId === 'string' ? `turn ${receipt.turnId}` : undefined,
  };
}

export async function appServerWaitForReply({
  threadId,
  timeoutMs = 60000,
}: {
  threadId: string;
  timeoutMs?: number;
}): Promise<WaitForReplyResult> {
  // Reuse the existing session client; poll thread/items/list for a fresh agent message.
  const baseline = await appServerReadThread({ threadId, limit: 200 });
  const seen = new Set(baseline.turns.map((turn) => turn.turnKey));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const page = await appServerReadThread({ threadId, limit: 200 });
    const fresh = page.turns.filter((turn) => !seen.has(turn.turnKey) && turn.role === 'assistant' && turn.text);
    const reply = fresh.at(-1)?.text ?? '';
    if (reply) {
      return {
        threadId,
        reply,
        backend: 'app-server',
        experimental: false,
        delivery: 'replied',
      };
    }
  }
  return {
    threadId,
    reply: '',
    backend: 'app-server',
    experimental: false,
    delivery: 'timeout',
  };
}

export async function appServerOpenThread(threadId: string): Promise<OpenThreadResult> {
  const { client } = await openCodexSession();
  try {
    await client.request('thread/resume', { threadId, excludeTurns: true });
    return { threadId, backend: 'app-server' };
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
