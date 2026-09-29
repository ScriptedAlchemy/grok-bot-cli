import type {
  ChatGptDesktopStatus,
  ChatGptDesktopTarget,
  ListHostsResult,
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
  listThreads(options?: {
    limit?: number;
    cursor?: string;
    /** Any string: `all` (default) | `local` | hostId / friendly name from list_hosts. Not an enum. */
    host?: string;
    /** Any modelProvider id (app-server modelProviders). Omit = all. See list_hosts. Not an enum. */
    modelProvider?: string;
    groupBy?: 'host';
  }): Promise<ListThreadsResult>;
  /** Optional; facades that support app-server search implement this. */
  searchThreads?(options: {
    query: string;
    limit?: number;
    /** Any string; see list_hosts. Not an enum. */
    host?: string;
    /** Any modelProvider id; see list_hosts. Not an enum. */
    modelProvider?: string;
    groupBy?: 'host';
  }): Promise<ListThreadsResult>;
  /**
   * Optional; facades that discover remote-control hosts implement this.
   * Returns `local` + every `remote-thread-summaries-v3:<hostId>` host with
   * counts / friendly names, plus discovered `modelProviders`. Never hardcode
   * those ids — new machines/connections appear with no code change.
   */
  listHosts?(): Promise<ListHostsResult>;
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
