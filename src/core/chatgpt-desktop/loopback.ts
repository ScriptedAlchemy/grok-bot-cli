import { CdpHostRejectedError } from './errors.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export const DEFAULT_CDP_PORT = 9222;
export const CDP_LOOPBACK_HOST = '127.0.0.1' as const;

export function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return LOOPBACK.has(host);
}

/** Reject any non-loopback host. CDP stays local-only with no remote transport. */
export function assertLoopbackHostname(hostname: string): void {
  if (!isLoopbackHostname(hostname)) {
    throw new CdpHostRejectedError(hostname);
  }
}

/**
 * Build the HTTP base URL for the Chromium debug port.
 * Always dials 127.0.0.1 — never a caller-supplied host.
 */
export function cdpHttpBase(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('CDP port must be an integer 1-65535');
  }
  return `http://${CDP_LOOPBACK_HOST}:${port}`;
}

/** Rewrite a debugger WebSocket URL so the host is forced to 127.0.0.1. */
export function forceLoopbackWebSocketUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CdpHostRejectedError(String(raw));
  }
  assertLoopbackHostname(url.hostname);
  if (url.username || url.password || url.hash) throw new CdpHostRejectedError(raw);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Expected ws(s) debugger URL, got ${url.protocol}`);
  }
  url.hostname = CDP_LOOPBACK_HOST;
  url.protocol = 'ws:';
  return url.toString();
}

export function resolveCdpPort(env: NodeJS.ProcessEnv = process.env, explicit?: number): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > 65535) {
      throw new RangeError('CDP port must be an integer 1-65535');
    }
    return explicit;
  }
  const raw = (env.CHATGPT_DESKTOP_CDP_PORT || '').trim();
  if (!raw) return DEFAULT_CDP_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('CHATGPT_DESKTOP_CDP_PORT must be an integer 1-65535');
  }
  return port;
}
