/**
 * Remote-control thread ownership from ChatGPT Desktop's
 * `~/.codex/.codex-global-state.json` (`remote-thread-summaries-v3:<hostId>`).
 *
 * Shared by codex-bridge send/read and the ChatGPT Desktop adapter so both
 * surfaces map "thread not loaded" to the same typed error.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_THREAD_ID_PREFIX, normalizeCodexThreadId } from './thread-id.js';

const REMOTE_SUMMARY_KEY = /^remote-thread-summaries-v3:(.+)$/;

/**
 * Thread exists on a remote-control host and is not loaded on the local
 * app-server. SSH remoting is a follow-up — this error names the owner.
 */
export class RemoteThreadNotLoadedError extends Error {
  /**
   * @param {string} threadId
   * @param {string | null} [hostId]
   * @param {string | null} [hostName]
   */
  constructor(threadId, hostId = null, hostName = null) {
    const hostLabel = hostName
      ? `${JSON.stringify(hostName)} (${JSON.stringify(hostId)})`
      : hostId
        ? JSON.stringify(hostId)
        : null;
    const owner = hostLabel
      ? `owned by remote-control host ${hostLabel}`
      : 'owned by a remote-control host (hostId unknown; check ~/.codex/.codex-global-state.json)';
    const hint = hostId
      ? `Read this thread via host ${JSON.stringify(hostId)}'s app-server`
        + (hostName ? ` (${hostName})` : '')
        + '. SSH remoting is not implemented in this adapter.'
      : "Read this thread via the owning host's app-server. SSH remoting is not implemented in this adapter.";
    super(
      `Codex thread ${JSON.stringify(threadId)} is not loaded on the local app-server; ${owner}. ${hint}`,
    );
    this.name = 'RemoteThreadNotLoadedError';
    this.code = 'REMOTE_THREAD_NOT_LOADED';
    this.delivery = 'rejected';
    this.reason = 'remote-thread-not-loaded';
    this.threadId = threadId;
    this.hostId = hostId;
    this.hostName = hostName;
    this.hint = hint;
  }
}

export function codexGlobalStatePath(env = process.env) {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  return join(home, '.codex-global-state.json');
}

/** @returns {Record<string, unknown> | null} */
export function loadCodexGlobalState(env = process.env) {
  let raw;
  try {
    raw = readFileSync(codexGlobalStatePath(env), 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Desktop keeps atom keys one level below the global state root. */
export function codexStateEntries(data) {
  const nested = data?.['electron-persisted-atom-state'];
  return [nested, data].filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * @param {string} threadId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ hostId: string, hostName: string | null } | null}
 */
export function findRemoteThreadHost(threadId, env = process.env) {
  let bare;
  try {
    bare = normalizeCodexThreadId(threadId);
  } catch {
    bare = typeof threadId === 'string' && threadId.startsWith(LOCAL_THREAD_ID_PREFIX)
      ? threadId.slice(LOCAL_THREAD_ID_PREFIX.length)
      : threadId;
  }
  if (!bare) return null;
  const data = loadCodexGlobalState(env);
  if (!data) return null;
  const hostNames = collectHostNames(data);

  for (const [key, value] of codexStateEntries(data).flatMap(Object.entries)) {
    const match = REMOTE_SUMMARY_KEY.exec(key);
    if (!match?.[1]) continue;
    const hostId = match[1];
    const hostName = hostNames.get(hostId) ?? extractHostName(value) ?? null;
    for (const entry of extractThreadEntries(value)) {
      const id = threadIdFromEntry(entry);
      if (!id) continue;
      const entryBare = id.startsWith(LOCAL_THREAD_ID_PREFIX)
        ? id.slice(LOCAL_THREAD_ID_PREFIX.length)
        : id;
      if (entryBare === bare) return { hostId, hostName };
    }
  }
  return null;
}

/**
 * Map app-server "thread not loaded" / unknown-thread errors to a typed remote
 * error when the id appears under remote-control summaries.
 * @param {unknown} error
 * @param {string} threadId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Error}
 */
export function mapRemoteThreadError(error, threadId, env = process.env) {
  const message = errorMessage(error);
  if (!/thread not loaded|not loaded|no rollout found|thread not found|invalid thread id/i.test(message)) {
    return error instanceof Error ? error : new Error(message || String(error));
  }
  const remote = findRemoteThreadHost(threadId, env);
  if (remote) {
    return new RemoteThreadNotLoadedError(threadId, remote.hostId, remote.hostName);
  }
  // "thread not loaded" without a known remote host still gets a typed hint.
  if (/thread not loaded|not loaded/i.test(message)) {
    return new RemoteThreadNotLoadedError(threadId, null, null);
  }
  return error instanceof Error ? error : new Error(message || String(error));
}

function collectHostNames(data) {
  const names = new Map();
  for (const [key, value] of codexStateEntries(data).flatMap(Object.entries)) {
    if (!/remote-host|hosts|host-meta|host_directory|environments/i.test(key)) continue;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const pair = hostNameFromEntry(entry);
        if (pair && !names.has(pair.hostId)) names.set(pair.hostId, pair.hostName);
      }
      continue;
    }
    for (const [hostId, entry] of Object.entries(value)) {
      const fromEntry = hostNameFromEntry(entry);
      if (fromEntry) {
        if (!names.has(fromEntry.hostId)) names.set(fromEntry.hostId, fromEntry.hostName);
        continue;
      }
      const label = stringField(entry, ['name', 'hostName', 'displayName', 'envName', 'label', 'title']);
      if (label && !names.has(hostId)) names.set(hostId, label);
    }
  }
  return names;
}

function hostNameFromEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const hostId = stringField(entry, ['hostId', 'id', 'host_id', 'uuid']);
  const hostName = stringField(entry, ['name', 'hostName', 'displayName', 'envName', 'label', 'title']);
  if (!hostId || !hostName) return null;
  return { hostId, hostName };
}

function extractHostName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return stringField(value, [
    'hostName', 'displayName', 'name', 'envName', 'label', 'title', 'friendlyName',
  ]);
}

function extractThreadEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value;
  for (const key of ['threads', 'summaries', 'items', 'data', 'conversations']) {
    if (Array.isArray(record[key])) return record[key];
  }
  const entries = [];
  for (const [key, entry] of Object.entries(record)) {
    if ([
      'pinnedIds', 'pinned', 'pinnedThreadIds', 'hostName', 'displayName', 'name',
      'envName', 'label', 'title', 'friendlyName', 'hostId', 'version',
    ].includes(key)) continue;
    if (typeof entry === 'string') continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = stringField(entry, ['id', 'threadId', 'thread_id', 'conversationId']);
      entries.push(id ? entry : { ...entry, id: key });
    }
  }
  return entries;
}

function threadIdFromEntry(entry) {
  if (typeof entry === 'string' && entry) return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return stringField(entry, ['id', 'threadId', 'thread_id', 'conversationId']);
}

function stringField(row, keys) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function errorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) return String(error.message);
  if (typeof error === 'object' && error && 'rpc' in error) {
    const rpc = error.rpc;
    if (rpc && typeof rpc.message === 'string') return rpc.message;
  }
  return String(error);
}
