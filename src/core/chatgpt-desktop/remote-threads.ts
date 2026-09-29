/**
 * Remote-control thread summaries from ChatGPT Desktop's
 * `~/.codex/.codex-global-state.json`.
 *
 * Keys are shaped like `remote-thread-summaries-v3:<hostId>` and may hold
 * titles, ids, remote project info, and pinned ids. The file is app-internal
 * and may change — parse defensively and ignore unknown shapes.
 *
 * SSH remoting is intentionally not implemented here (follow-up).
 */

import { loadCodexGlobalState } from '../codex/remote-control.js';
export { codexGlobalStatePath, loadCodexGlobalState } from '../codex/remote-control.js';

import { toAppServerThreadId, toDesktopThreadId } from './thread-ids.js';
import type { ChatGptDesktopThread } from './types.js';

const REMOTE_SUMMARY_KEY = /^remote-thread-summaries-v3:(.+)$/;

export type RemoteHostInfo = {
  readonly hostId: string;
  readonly hostName: string | null;
};

export type RemoteThreadRecord = ChatGptDesktopThread & {
  readonly location: 'remote';
  readonly hostId: string;
  readonly hostName: string | null;
};

export type RemoteThreadLookup = {
  readonly hostId: string;
  readonly hostName: string | null;
  readonly thread: RemoteThreadRecord | null;
};

/**
 * Parse every `remote-thread-summaries-v3:<hostId>` entry into flat remote
 * thread rows. Unknown/malformed entries are skipped.
 */
export function listRemoteThreadsFromState(
  env: NodeJS.ProcessEnv = process.env,
): RemoteThreadRecord[] {
  const data = loadCodexGlobalState(env);
  if (!data) return [];
  const hostNames = collectHostNames(data);
  const out: RemoteThreadRecord[] = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(data)) {
    const match = REMOTE_SUMMARY_KEY.exec(key);
    if (!match?.[1]) continue;
    const hostId = match[1];
    const hostName = hostNames.get(hostId) ?? extractHostName(value);
    const pinnedIds = extractPinnedIds(value);
    for (const entry of extractThreadEntries(value)) {
      const mapped = mapRemoteEntry(entry, { hostId, hostName, pinnedIds });
      if (!mapped) continue;
      const bare = toAppServerThreadId(mapped.threadId) ?? mapped.threadId;
      const dedupe = `${hostId}:${bare}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push(mapped);
    }
  }
  return out;
}

/** Best-effort hostId (+ optional summary row) for a thread under remote summaries. */
export function findRemoteThread(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoteThreadLookup | null {
  const bare = toAppServerThreadId(threadId) ?? threadId;
  if (!bare) return null;
  for (const thread of listRemoteThreadsFromState(env)) {
    const id = toAppServerThreadId(thread.threadId) ?? thread.threadId;
    if (id === bare) {
      return { hostId: thread.hostId, hostName: thread.hostName, thread };
    }
  }
  return null;
}

/** Best-effort hostId for a thread listed under a remote-control summary. */
export function findRemoteThreadHostId(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return findRemoteThread(threadId, env)?.hostId ?? null;
}

export type DiscoveredHost = {
  readonly hostId: string;
  readonly hostName: string | null;
  readonly location: 'local' | 'remote';
  readonly threadCount: number;
};

/**
 * Discover hosts dynamically: always include `local`, plus every
 * `remote-thread-summaries-v3:<hostId>` key (with friendly names / counts).
 */
export function listDiscoveredHosts(
  env: NodeJS.ProcessEnv = process.env,
  {
    localThreadCount = 0,
  }: {
    localThreadCount?: number;
  } = {},
): DiscoveredHost[] {
  const remotes = listRemoteThreadsFromState(env);
  const byHost = new Map<string, DiscoveredHost>();
  byHost.set('local', {
    hostId: 'local',
    hostName: 'local',
    location: 'local',
    threadCount: localThreadCount,
  });

  const data = loadCodexGlobalState(env);
  if (data) {
    const hostNames = collectHostNames(data);
    for (const key of Object.keys(data)) {
      const match = REMOTE_SUMMARY_KEY.exec(key);
      if (!match?.[1]) continue;
      const hostId = match[1];
      const summary = data[key];
      const hostName = hostNames.get(hostId) ?? extractHostName(summary) ?? null;
      byHost.set(hostId, {
        hostId,
        hostName,
        location: 'remote',
        threadCount: 0,
      });
    }
  }

  for (const thread of remotes) {
    const existing = byHost.get(thread.hostId);
    if (existing) {
      byHost.set(thread.hostId, {
        ...existing,
        hostName: existing.hostName ?? thread.hostName,
        threadCount: existing.threadCount + 1,
      });
    } else {
      byHost.set(thread.hostId, {
        hostId: thread.hostId,
        hostName: thread.hostName,
        location: 'remote',
        threadCount: 1,
      });
    }
  }

  return [...byHost.values()].sort((a, b) => {
    if (a.hostId === 'local') return -1;
    if (b.hostId === 'local') return 1;
    return a.hostId.localeCompare(b.hostId);
  });
}

function collectHostNames(data: Record<string, unknown>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, value] of Object.entries(data)) {
    if (!/remote-host|hosts|host-meta|host_directory|environments/i.test(key)) continue;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const pair = hostNameFromEntry(entry);
        if (pair) names.set(pair.hostId, pair.hostName);
      }
      continue;
    }
    for (const [hostId, entry] of Object.entries(value as Record<string, unknown>)) {
      const fromEntry = hostNameFromEntry(entry);
      if (fromEntry) {
        names.set(fromEntry.hostId, fromEntry.hostName);
        continue;
      }
      const label = stringField(entry, ['name', 'hostName', 'displayName', 'envName', 'label', 'title']);
      if (label) names.set(hostId, label);
    }
  }
  return names;
}

function hostNameFromEntry(entry: unknown): { hostId: string; hostName: string } | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const row = entry as Record<string, unknown>;
  const hostId = stringField(row, ['hostId', 'id', 'host_id', 'uuid']);
  const hostName = stringField(row, ['name', 'hostName', 'displayName', 'envName', 'label', 'title']);
  if (!hostId || !hostName) return null;
  return { hostId, hostName };
}

function extractHostName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return stringField(value as Record<string, unknown>, [
    'hostName',
    'displayName',
    'name',
    'envName',
    'label',
    'title',
    'friendlyName',
  ]);
}

function extractPinnedIds(value: unknown): Set<string> {
  const pinned = new Set<string>();
  if (!value || typeof value !== 'object') return pinned;
  const record = value as Record<string, unknown>;
  for (const key of ['pinnedIds', 'pinned', 'pinnedThreadIds', 'pinned_ids']) {
    const arr = record[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string' && item) pinned.add(item);
      else if (item && typeof item === 'object') {
        const id = stringField(item as Record<string, unknown>, ['id', 'threadId', 'thread_id']);
        if (id) pinned.add(id);
      }
    }
  }
  return pinned;
}

function extractThreadEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['threads', 'summaries', 'items', 'data', 'conversations']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  // Object map keyed by thread id → treat values (and string keys) as entries.
  const entries: unknown[] = [];
  for (const [key, entry] of Object.entries(record)) {
    if (
      [
        'pinnedIds',
        'pinned',
        'pinnedThreadIds',
        'hostName',
        'displayName',
        'name',
        'envName',
        'label',
        'title',
        'friendlyName',
        'hostId',
        'version',
      ].includes(key)
    ) {
      continue;
    }
    if (typeof entry === 'string') continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      if (!stringField(row, ['id', 'threadId', 'thread_id', 'conversationId'])) {
        entries.push({ ...row, id: key });
      } else {
        entries.push(entry);
      }
    }
  }
  return entries;
}

function mapRemoteEntry(
  entry: unknown,
  {
    hostId,
    hostName,
    pinnedIds,
  }: {
    hostId: string;
    hostName: string | null;
    pinnedIds: Set<string>;
  },
): RemoteThreadRecord | null {
  if (typeof entry === 'string' && entry) {
    return {
      threadId: toDesktopThreadId(entry),
      title: entry,
      pinned: pinnedIds.has(entry),
      selected: false,
      kind: 'remote',
      location: 'remote',
      hostId,
      hostName,
    };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const row = entry as Record<string, unknown>;
  const id = stringField(row, ['id', 'threadId', 'thread_id', 'conversationId']);
  if (!id) return null;
  const title =
    stringField(row, ['title', 'name', 'preview', 'label']) || id;
  const projectId = stringField(row, ['projectId', 'project_id']);
  const project =
    stringField(row, ['project', 'projectName', 'project_name', 'cwd']) || projectId || undefined;
  const preview = stringField(row, ['preview', 'snippet']);
  const cwd = stringField(row, ['cwd', 'workingDirectory', 'working_directory']);
  const modelProvider = stringField(row, ['modelProvider', 'model_provider', 'provider']);
  const model = stringField(row, ['model']);
  const originator = stringField(row, ['originator', 'source']);
  const createdAt = numberField(row, ['createdAt', 'created_at']);
  const updatedAt = numberField(row, ['updatedAt', 'updated_at']);
  const sectionName = stringField(row, ['sectionName', 'section']);
  const sectionId = stringField(row, ['sectionId', 'section_id']) || sectionName;
  const pinned =
    pinnedIds.has(id) ||
    row.pinned === true ||
    sectionId === 'Pinned' ||
    sectionName === 'Pinned';

  return {
    threadId: toDesktopThreadId(id),
    title,
    pinned,
    selected: false,
    kind: 'remote',
    location: 'remote',
    hostId,
    hostName,
    ...(project ? { project } : {}),
    ...(projectId ? { projectId } : {}),
    ...(preview ? { preview } : {}),
    ...(cwd ? { cwd } : { cwd: null }),
    createdAt: createdAt ?? null,
    updatedAt: updatedAt ?? null,
    ...(sectionId
      ? { section: { id: sectionId, name: sectionName ?? sectionId } }
      : { section: null }),
    ...(modelProvider ? { modelProvider } : { modelProvider: null }),
    ...(model ? { model } : { model: null }),
    ...(originator ? { originator } : { originator: null }),
  };
}

function stringField(row: Record<string, unknown> | unknown, keys: string[]): string | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function numberField(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}
