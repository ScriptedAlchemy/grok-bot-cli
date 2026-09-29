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
  readThread(options: { threadId: string; limit?: number }): Promise<ReadThreadResult>;
  /** Omitting `threadId` starts a new thread (composer in a new chat). */
  sendMessage(options: { threadId?: string; text: string }): Promise<SendMessageResult>;
  waitForReply(options: { threadId: string; timeoutMs?: number }): Promise<WaitForReplyResult>;
  openThread(threadId: string): Promise<OpenThreadResult>;
  status(): Promise<ChatGptDesktopStatus>;
  close(): Promise<void>;
}
