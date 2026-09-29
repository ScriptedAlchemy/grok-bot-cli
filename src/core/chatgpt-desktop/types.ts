export type ChatGptDesktopBackend = 'cdp' | 'app-server';

export type ChatGptDesktopTarget = {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly attached: boolean;
};

export type ChatGptDesktopThread = {
  readonly threadId: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly selected: boolean;
  readonly kind: string;
};

export type ChatGptDesktopTurn = {
  readonly turnKey: string;
  readonly role: 'user' | 'assistant' | 'status';
  readonly text: string;
  /** User bubble text when the turn holds both sides. */
  readonly userText?: string;
  /** Final assistant markdown when present on the same turn. */
  readonly assistantText?: string;
};

export type ChatGptDesktopStatus = {
  readonly reachable: boolean;
  readonly port: number;
  readonly host: '127.0.0.1';
  readonly browser?: string;
  readonly protocolVersion?: string;
  readonly webSocketDebuggerUrl?: string;
  readonly targetCount?: number;
  readonly mainWindowTargetId?: string | null;
  readonly appServerFallback?: {
    readonly reachable: boolean;
    readonly mode?: string;
    readonly socketPath?: string;
  };
  readonly message: string;
  readonly exitCode: 0 | 1;
};

export type ListThreadsResult = {
  readonly threads: readonly ChatGptDesktopThread[];
  readonly backend: ChatGptDesktopBackend;
  readonly limit: number;
};

export type ReadThreadResult = {
  readonly threadId: string;
  readonly turns: readonly ChatGptDesktopTurn[];
  readonly backend: ChatGptDesktopBackend;
  readonly limit: number;
  readonly full: boolean;
};

export type SendMessageResult = {
  readonly threadId: string;
  readonly backend: ChatGptDesktopBackend;
  readonly experimental: boolean;
  readonly delivery: 'accepted' | 'rejected' | 'unknown';
  readonly message?: string;
  /** Temporary sidebar id before reload (`local:client-new-thread:…`). */
  readonly temporaryThreadId?: string;
  readonly project?: string;
  readonly sentVia?: 'enter' | 'button';
};

export type WaitForReplyResult = {
  readonly threadId: string;
  readonly reply: string;
  readonly backend: ChatGptDesktopBackend;
  readonly experimental: boolean;
  readonly delivery: 'replied' | 'timeout' | 'rejected' | 'unknown';
  /** Real conversation id from `data-response-annotation-conversation`. */
  readonly conversationId?: string;
};

export type OpenThreadResult = {
  readonly threadId: string;
  readonly backend: ChatGptDesktopBackend;
};
