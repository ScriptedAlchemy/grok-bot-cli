import type { ChatGptDesktopAdapter } from './adapter.js';
import { CdpChatGptDesktopAdapter } from './cdp-adapter.js';
import {
  appServerListThreads,
  appServerOpenThread,
  appServerReadThread,
  appServerSendMessage,
  appServerStatusProbe,
  appServerWaitForReply,
} from './app-server-fallback.js';
import { CdpUnreachableError, NotImplementedError } from './errors.js';
import { resolveCdpPort } from './loopback.js';
import type {
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';

/** Optional overrides so tests can prove CDP→app-server fallback without a live daemon. */
export type ChatGptDesktopFallbacks = {
  listThreads: typeof appServerListThreads;
  readThread: typeof appServerReadThread;
  sendMessage: typeof appServerSendMessage;
  waitForReply: typeof appServerWaitForReply;
  openThread: typeof appServerOpenThread;
  statusProbe: typeof appServerStatusProbe;
};

const defaultFallbacks: ChatGptDesktopFallbacks = {
  listThreads: appServerListThreads,
  readThread: appServerReadThread,
  sendMessage: appServerSendMessage,
  waitForReply: appServerWaitForReply,
  openThread: appServerOpenThread,
  statusProbe: appServerStatusProbe,
};

/**
 * Prefer CDP for ChatGPT Desktop (Desktop can do more than app-server).
 * When CDP is unreachable, reuse the existing Codex app-server client for
 * operations it already serves — never duplicate that JSON-RPC stack.
 * Every list/read/send/wait/open result reports `backend: "cdp" | "app-server"`.
 */
export class ChatGptDesktopFacade implements ChatGptDesktopAdapter {
  #cdp: ChatGptDesktopAdapter;
  #port: number;
  #cdpConnected = false;
  #fallbacks: ChatGptDesktopFallbacks;

  constructor(
    cdp: ChatGptDesktopAdapter = new CdpChatGptDesktopAdapter(),
    port = resolveCdpPort(),
    fallbacks: ChatGptDesktopFallbacks = defaultFallbacks,
  ) {
    this.#cdp = cdp;
    this.#port = port;
    this.#fallbacks = fallbacks;
  }

  async connect({ port }: { port: number }): Promise<void> {
    this.#port = resolveCdpPort(process.env, port);
    try {
      await this.#cdp.connect({ port: this.#port });
      this.#cdpConnected = true;
    } catch (error) {
      this.#cdpConnected = false;
      throw error;
    }
  }

  async listTargets(): Promise<readonly ChatGptDesktopTarget[]> {
    await this.#ensureCdp();
    return this.#cdp.listTargets();
  }

  async listThreads(options?: { limit?: number }): Promise<ListThreadsResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.listThreads(options);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.listThreads(options);
    }
  }

  async readThread(options: { threadId: string; limit?: number }): Promise<ReadThreadResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.readThread(options);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.readThread(options);
    }
  }

  async sendMessage(options: { threadId?: string; text: string }): Promise<SendMessageResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.sendMessage(options);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.sendMessage(options);
    }
  }

  async waitForReply(options: {
    threadId: string;
    timeoutMs?: number;
  }): Promise<WaitForReplyResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.waitForReply(options);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.waitForReply(options);
    }
  }

  async openThread(threadId: string): Promise<OpenThreadResult> {
    try {
      await this.#ensureCdp();
      return await this.#cdp.openThread(threadId);
    } catch (error) {
      if (!isCdpFailure(error)) throw error;
      return this.#fallbacks.openThread(threadId);
    }
  }

  async status(): Promise<ChatGptDesktopStatus> {
    const cdpStatus = await this.#cdp.status();
    let appServerFallback: ChatGptDesktopStatus['appServerFallback'];
    try {
      appServerFallback = await this.#fallbacks.statusProbe();
    } catch {
      appServerFallback = { reachable: false };
    }
    const reachable = cdpStatus.reachable || Boolean(appServerFallback?.reachable);
    return {
      ...cdpStatus,
      port: this.#port,
      appServerFallback,
      reachable,
      message: cdpStatus.reachable
        ? cdpStatus.message
        : appServerFallback?.reachable
          ? 'CDP unreachable; Codex app-server fallback is available'
          : cdpStatus.message,
      exitCode: reachable ? 0 : 1,
    };
  }

  async close(): Promise<void> {
    this.#cdpConnected = false;
    await this.#cdp.close();
  }

  async #ensureCdp(): Promise<void> {
    if (this.#cdpConnected) return;
    await this.#cdp.connect({ port: this.#port });
    this.#cdpConnected = true;
  }
}

function isCdpFailure(error: unknown): boolean {
  if (error instanceof CdpUnreachableError) return true;
  if (error instanceof NotImplementedError) return false;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    return code === 'CDP_UNREACHABLE' || code === 'CDP_HOST_REJECTED';
  }
  return false;
}

let activeAdapter: ChatGptDesktopAdapter | null = null;

export function getChatGptDesktopAdapter(): ChatGptDesktopAdapter {
  if (!activeAdapter) activeAdapter = new ChatGptDesktopFacade();
  return activeAdapter;
}

/** Test hook: inject a fake adapter (or null to restore the default facade). */
export function setChatGptDesktopAdapterForTests(adapter: ChatGptDesktopAdapter | null): void {
  activeAdapter = adapter;
}
