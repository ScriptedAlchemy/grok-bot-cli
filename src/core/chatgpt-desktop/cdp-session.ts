import { CdpUnreachableError } from './errors.js';
import {
  assertLoopbackHostname,
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
      response = await fetch(`${base}/json/version`, { signal });
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
    return (await response.json()) as CdpVersionInfo;
  }

  static async fetchJsonList(port: number, { signal }: { signal?: AbortSignal } = {}): Promise<unknown[]> {
    const base = cdpHttpBase(port);
    let response: Response;
    try {
      response = await fetch(`${base}/json/list`, { signal });
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
    const parsed = new URL(url);
    assertLoopbackHostname(parsed.hostname);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.#ws = ws;
      const onAbort = () => {
        ws.close();
        reject(new Error('CDP connect aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      ws.addEventListener('open', () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new CdpUnreachableError(`CDP WebSocket failed for ${url}`));
      }, { once: true });
      ws.addEventListener('message', (event) => this.#onMessage(event.data));
      ws.addEventListener('close', () => {
        this.#closed = true;
        for (const [, pending] of this.#pending) {
          pending.reject(new Error('CDP WebSocket closed'));
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
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#ws!.send(JSON.stringify(payload));
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
    if (typeof message.id !== 'number') return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || 'CDP error'));
      return;
    }
    pending.resolve(message.result);
  }
}
