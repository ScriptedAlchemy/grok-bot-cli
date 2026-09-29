import { CdpUnreachableError } from './errors.js';
import {
  cdpHttpBase,
  forceLoopbackWebSocketUrl,
} from './loopback.js';

export type CdpVersionInfo = {
  readonly Browser?: string;
  readonly 'Protocol-Version'?: string;
  readonly webSocketDebuggerUrl?: string;
  readonly [key: string]: unknown;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Minimal local-only CDP client. Connects to 127.0.0.1 only; never accepts a
 * remote host. Uses Node's built-in WebSocket (no extra dependency).
 */
export class CdpSession {
  #port: number;
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  constructor(port: number) {
    this.#port = port;
  }

  get port(): number {
    return this.#port;
  }

  get closed(): boolean {
    return this.#closed || this.#ws === null || this.#ws.readyState === WebSocket.CLOSED;
  }

  static async fetchVersion(port: number, { signal }: { signal?: AbortSignal } = {}): Promise<CdpVersionInfo> {
    const base = cdpHttpBase(port);
    let response: Response;
    try {
      response = await fetch(`${base}/json/version`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch (error) {
      throw new CdpUnreachableError(
        `ChatGPT Desktop CDP not reachable at ${base}/json/version: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!response.ok) {
      throw new CdpUnreachableError(
        `ChatGPT Desktop CDP /json/version returned HTTP ${response.status}`,
      );
    }
    const version = (await response.json()) as CdpVersionInfo;
    if (typeof version.webSocketDebuggerUrl === 'string') {
      forceLoopbackWebSocketUrl(version.webSocketDebuggerUrl);
    }
    return version;
  }

  static async fetchJsonList(port: number, { signal }: { signal?: AbortSignal } = {}): Promise<unknown[]> {
    const base = cdpHttpBase(port);
    let response: Response;
    try {
      response = await fetch(`${base}/json/list`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch (error) {
      throw new CdpUnreachableError(
        `ChatGPT Desktop CDP not reachable at ${base}/json/list: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (!response.ok) {
      throw new CdpUnreachableError(
        `ChatGPT Desktop CDP /json/list returned HTTP ${response.status}`,
      );
    }
    const body: unknown = await response.json();
    return Array.isArray(body) ? body : [];
  }

  async connect({ signal }: { signal?: AbortSignal } = {}): Promise<CdpVersionInfo> {
    if (this.#ws && !this.closed) {
      throw new Error('CDP session already connected');
    }
    const version = await CdpSession.fetchVersion(this.#port, { signal });
    const rawUrl = version.webSocketDebuggerUrl;
    if (typeof rawUrl !== 'string' || !rawUrl) {
      throw new CdpUnreachableError('CDP /json/version omitted webSocketDebuggerUrl');
    }
    const url = forceLoopbackWebSocketUrl(rawUrl);

    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.#ws = ws;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        ws.close();
        reject(new CdpUnreachableError('CDP connect aborted or timed out'));
      };
      const timer = setTimeout(onAbort, 5000);
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        cleanup();
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        cleanup();
        reject(new CdpUnreachableError(`CDP WebSocket failed for ${url}`));
      }, { once: true });
      ws.addEventListener('message', (event) => this.#onMessage(event.data));
      ws.addEventListener('close', () => {
        cleanup();
        reject(new CdpUnreachableError('CDP WebSocket closed before connecting'));
        this.#closed = true;
        for (const [, pending] of this.#pending) {
          clearTimeout(pending.timer);
          pending.reject(new CdpUnreachableError('CDP WebSocket closed'));
        }
        this.#pending.clear();
      });
    });
    this.#closed = false;
    return version;
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    { sessionId }: { sessionId?: string } = {},
  ): Promise<T> {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      throw new CdpUnreachableError('CDP session is not connected');
    }
    const id = this.#nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpUnreachableError(`CDP ${method} timed out`));
      }, 10000);
      this.#pending.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.#ws!.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate<T = unknown>(
    expression: string,
    { sessionId, awaitPromise = true }: { sessionId?: string; awaitPromise?: boolean } = {},
  ): Promise<T> {
    const result = await this.send<{
      result?: { type?: string; value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    }, { sessionId });
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'Runtime.evaluate failed';
      throw new Error(text);
    }
    return result.result?.value as T;
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpUnreachableError('CDP session closed'));
    }
    this.#pending.clear();
    this.#ws?.close();
    this.#ws = null;
  }

  #onMessage(data: unknown): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'CDP error'));
      return;
    }
    pending.resolve(message.result);
  }
}
