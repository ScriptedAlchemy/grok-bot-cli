import type { ChatGptDesktopThread } from './types.js';

/** Agent Bundle rejects documents above 1 MiB; leave room for its envelope. */
export const DESKTOP_RESULT_BUDGET_BYTES = 600 * 1024;
export const DESKTOP_THREAD_TITLE_CHARS = 200;

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compact(value: string, maxChars: number): { value: string; clipped: boolean } {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(normalized);
  return { value: chars.slice(0, maxChars).join(''), clipped: chars.length > maxChars };
}

/** Compact display metadata after search has matched the original full text. */
export function compactThreadRow(thread: ChatGptDesktopThread): ChatGptDesktopThread {
  const title = compact(thread.title, DESKTOP_THREAD_TITLE_CHARS);
  const preview = typeof thread.preview === 'string' ? compact(thread.preview, 200) : null;
  const cwd = typeof thread.cwd === 'string' ? compact(thread.cwd, 2048) : null;
  const project = typeof thread.project === 'string' ? compact(thread.project, 256) : null;
  const hostName = typeof thread.hostName === 'string' ? compact(thread.hostName, 256) : null;
  return {
    ...thread,
    title: title.value,
    ...(title.clipped ? { titleTruncated: true } : {}),
    ...(preview ? { preview: preview.value, ...(preview.clipped ? { previewTruncated: true } : {}) } : {}),
    ...(cwd ? { cwd: cwd.value, ...(cwd.clipped ? { cwdTruncated: true } : {}) } : {}),
    ...(project ? { project: project.value, ...(project.clipped ? { projectTruncated: true } : {}) } : {}),
    ...(hostName ? { hostName: hostName.value, ...(hostName.clipped ? { hostNameTruncated: true } : {}) } : {}),
  };
}

export function compactThreadTitle(title: string): { title: string; titleTruncated: boolean } {
  const out = compact(title, DESKTOP_THREAD_TITLE_CHARS);
  return { title: out.value, titleTruncated: out.clipped };
}

export function minimalThreadRow(thread: ChatGptDesktopThread): ChatGptDesktopThread {
  return {
    threadId: thread.threadId,
    title: compact(thread.title, DESKTOP_THREAD_TITLE_CHARS).value,
    titleTruncated: true,
    pinned: thread.pinned,
    selected: thread.selected,
    kind: thread.kind,
    location: thread.location,
    hostId: thread.hostId,
    hostName: thread.hostName,
    modelProvider: thread.modelProvider,
    metadataTruncated: true,
  };
}

export function encodePageCursor(prefix: string, value: object): string {
  return prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodePageCursor<T>(prefix: string, cursor: string): T {
  if (!cursor.startsWith(prefix)) throw new Error('Invalid ChatGPT Desktop page cursor');
  try {
    return JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8')) as T;
  } catch {
    throw new Error('Invalid ChatGPT Desktop page cursor');
  }
}
