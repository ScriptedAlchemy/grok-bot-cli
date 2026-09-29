import type {
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ListThreadsResult,
  OpenThreadResult,
  ReadThreadResult,
  SendMessageResult,
  WaitForReplyResult,
} from './types.js';

/**
 * Stable surface for ChatGPT Desktop automation. CDP/DOM details stay behind
 * the implementation; callers use these methods only.
 */
export interface ChatGptDesktopAdapter {
  connect(options: { port: number }): Promise<void>;
  listTargets(): Promise<readonly ChatGptDesktopTarget[]>;
  listThreads(options?: { limit?: number }): Promise<ListThreadsResult>;
  readThread(options: {
    threadId: string;
    limit?: number;
    full?: boolean;
    openTimeoutMs?: number;
  }): Promise<ReadThreadResult>;
  /**
   * Send text. With `threadId`, opens that thread first. Without `threadId`,
   * starts a new chat (`project` prefers "Start new chat in <project>").
   */
  sendMessage(options: {
    threadId?: string;
    text: string;
    project?: string;
    openTimeoutMs?: number;
  }): Promise<SendMessageResult>;
  waitForReply(options: {
    threadId?: string;
    timeoutMs?: number;
  }): Promise<WaitForReplyResult>;
  openThread(
    threadId: string,
    options?: { openTimeoutMs?: number },
  ): Promise<OpenThreadResult>;
  status(): Promise<ChatGptDesktopStatus>;
  close(): Promise<void>;
}
