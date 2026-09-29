/**
 * Look up which remote-control host owns a Codex thread that is not loaded
 * locally. Reads `~/.codex/.codex-global-state.json` keys shaped like
 * `remote-thread-summaries-v3:<hostId>`. SSH remoting is intentionally not
 * implemented here — follow-up work.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { toAppServerThreadId } from './thread-ids.js';

const REMOTE_SUMMARY_KEY = /^remote-thread-summaries-v3:(.+)$/;

export function codexGlobalStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  return join(home, '.codex-global-state.json');
}

/** Best-effort hostId for a thread listed under a remote-control summary. */
export function findRemoteThreadHostId(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const bare = toAppServerThreadId(threadId) ?? threadId;
  if (!bare) return null;
  let raw: string;
  try {
    raw = readFileSync(codexGlobalStatePath(env), 'utf8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const match = REMOTE_SUMMARY_KEY.exec(key);
    if (!match) continue;
    if (summariesIncludeThread(value, bare)) return match[1] ?? null;
  }
  return null;
}

function summariesIncludeThread(value: unknown, threadId: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => entryMentionsThread(entry, threadId));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (threadId in record) return true;
    if (Array.isArray(record.threads)) {
      return record.threads.some((entry) => entryMentionsThread(entry, threadId));
    }
    if (Array.isArray(record.summaries)) {
      return record.summaries.some((entry) => entryMentionsThread(entry, threadId));
    }
    return Object.values(record).some((entry) => entryMentionsThread(entry, threadId));
  }
  return false;
}

function entryMentionsThread(entry: unknown, threadId: string): boolean {
  if (typeof entry === 'string') return entry === threadId;
  if (!entry || typeof entry !== 'object') return false;
  const row = entry as Record<string, unknown>;
  for (const key of ['id', 'threadId', 'thread_id', 'conversationId']) {
    if (row[key] === threadId) return true;
  }
  return false;
}
