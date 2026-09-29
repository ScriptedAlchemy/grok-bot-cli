export type ChatGptDesktopBackend = 'cdp' | 'app-server' | 'app-server+cdp' | 'app-server+remote-state' | 'app-server+cdp+remote-state' | 'cdp+remote-state' | 'remote-state';

export type ChatGptDesktopTarget = {
  readonly targetId: string;
  readonly type: string;
  readonly title: string;
  readonly titleTruncated?: boolean;
  readonly url: string;
  readonly attached: boolean;
};

export type ChatGptDesktopThreadLocation = 'local' | 'remote';

export type ChatGptDesktopThreadSection = {
  readonly id: string;
  readonly name: string | null;
};

export type ChatGptDesktopThread = {
  readonly threadId: string;
  readonly title: string;
  readonly titleTruncated?: boolean;
  readonly pinned: boolean;
  /** CDP-only: currently selected sidebar row. */
  readonly selected: boolean;
  readonly kind: string;
  /** Project folder name when known (CDP sidebar or app-server projectId). */
  readonly project?: string | null;
  readonly projectRootPath?: string;
  readonly preview?: string;
  readonly previewTruncated?: boolean;
  readonly cwd?: string | null;
  readonly cwdTruncated?: boolean;
  readonly createdAt?: number | null;
  readonly updatedAt?: number | null;
  readonly section?: ChatGptDesktopThreadSection | null;
  readonly projectId?: string | null;
  readonly status?: string;
  readonly modelProvider?: string | null;
  readonly model?: string | null;
  readonly originator?: string | null;
  /** Whether the thread is on the local app-server or a remote-control host. */
  readonly location?: ChatGptDesktopThreadLocation;
  /** Remote-control host id when `location` is `remote`; null for local. */
  readonly hostId?: string | null;
  /** Friendly host / env name from Desktop global state when known. */
  readonly hostName?: string | null;
  readonly projectTruncated?: boolean;
  readonly hostNameTruncated?: boolean;
  readonly metadataTruncated?: boolean;
};

export type ChatGptDesktopHostGroup = {
  readonly hostId: string;
  readonly hostName: string | null;
  readonly location: ChatGptDesktopThreadLocation;
  readonly threads: readonly ChatGptDesktopThread[];
};

export type ChatGptDesktopTurn = {
  /** Prefer DOM form `history-content:turn:<id>` when the bare turn id is known. */
  readonly turnKey: string;
  readonly role: 'user' | 'assistant' | 'status' | 'tool' | 'reasoning';
  readonly text: string;
  /** User bubble text when the turn holds both sides. */
  readonly userText?: string;
  /** Final assistant markdown when present on the same turn. */
  readonly assistantText?: string;
  /** A large turn is split into ordered fragments sharing this stable turnKey. */
  readonly textTruncated?: boolean;
  readonly continuation?: {
    readonly field: 'text' | 'userText' | 'assistantText';
    readonly offsetChars: number;
    readonly totalChars: number;
    readonly fieldComplete: boolean;
    readonly turnComplete: boolean;
  };
  readonly startedAt?: number | null;
  readonly endedAt?: number | null;
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
  readonly nextCursor?: string | null;
  readonly warnings?: readonly string[];
  readonly query?: string;
  /** Host filter applied: any string (`all` | `local` | hostId / friendly name from list_hosts). */
  readonly host?: string;
  /** Model-provider filter (any string; see list_hosts). Passed through to app-server `modelProviders`. */
  readonly modelProvider?: string;
  readonly project?: string;
  readonly groupBy?: 'host';
  /** Present when `groupBy: "host"`. */
  readonly groups?: readonly ChatGptDesktopHostGroup[];
};

export type ListHostsResult = {
  readonly hosts: readonly {
    readonly hostId: string;
    readonly hostName: string | null;
    readonly hostNameTruncated?: boolean;
    readonly location: ChatGptDesktopThreadLocation;
    readonly threadCount: number;
  }[];
  /** How hosts were discovered (e.g. remote-thread-summaries-v3+local). */
  readonly hostsSource: string;
  readonly modelProviders: readonly string[];
  /** How model providers were discovered (app-server method or thread/list-distinct). */
  readonly modelProvidersSource: string;
  readonly backend: ChatGptDesktopBackend;
  readonly warnings?: readonly string[];
};

export type ReadThreadResult = {
  readonly threadId: string;
  readonly turns: readonly ChatGptDesktopTurn[];
  readonly backend: ChatGptDesktopBackend;
  readonly limit: number;
  readonly full: boolean;
  readonly nextCursor?: string | null;
  readonly titleTruncated?: boolean;
  readonly complete?: boolean;
  readonly warnings?: readonly string[];
  readonly title?: string;
  readonly cwd?: string | null;
  readonly status?: string;
  readonly modelProvider?: string | null;
  readonly model?: string | null;
};

export type SendMessageResult = {
  readonly threadId: string;
  readonly backend: ChatGptDesktopBackend;
  readonly experimental: boolean;
  readonly delivery: 'accepted' | 'rejected' | 'unknown';
  readonly message?: string;
  /**
   * Temporary sidebar id before the real conversation annotation appears
   * (`local:client-new-thread:…`). Never used as `threadId` once the real id
   * is known from `data-response-annotation-conversation`.
   */
  readonly temporaryThreadId?: string;
  /** Real conversation id from `data-response-annotation-conversation`. */
  readonly conversationId?: string;
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
  readonly archived?: boolean;
};
