import { RemoteThreadNotLoadedError as SharedRemoteThreadNotLoadedError } from '../codex/remote-control.js';

/** Typed failure when a ChatGPT Desktop CDP/DOM operation is not yet implemented. */
export class NotImplementedError extends Error {
  readonly code = 'NOT_IMPLEMENTED' as const;
  readonly delivery = 'rejected' as const;
  readonly reason = 'not-implemented' as const;

  constructor(operation: string, detail?: string) {
    super(
      detail
        ? `ChatGPT Desktop ${operation} is not implemented: ${detail}`
        : `ChatGPT Desktop ${operation} is not implemented`,
    );
    this.name = 'NotImplementedError';
  }
}

/** Thrown when a CDP endpoint host is not loopback. */
export class CdpHostRejectedError extends Error {
  readonly code = 'CDP_HOST_REJECTED' as const;
  readonly delivery = 'rejected' as const;
  readonly reason = 'cdp-host-rejected' as const;

  constructor(host: string) {
    super(
      `ChatGPT Desktop CDP rejects non-loopback host ${JSON.stringify(host)}. ` +
        'Connect to 127.0.0.1 only; there is no remote transport.',
    );
    this.name = 'CdpHostRejectedError';
  }
}

/** Thrown when the local CDP endpoint is unreachable. */
export class CdpUnreachableError extends Error {
  readonly code = 'CDP_UNREACHABLE' as const;
  readonly delivery = 'rejected' as const;
  readonly reason = 'cdp-unreachable' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CdpUnreachableError';
  }
}

/**
 * Thread exists on a remote-control host and is not loaded on the local
 * app-server. Shared with codex send/read paths.
 */
export class RemoteThreadNotLoadedError extends SharedRemoteThreadNotLoadedError {
  declare readonly code: 'REMOTE_THREAD_NOT_LOADED';
  declare readonly delivery: 'rejected';
  declare readonly reason: 'remote-thread-not-loaded';
  declare readonly threadId: string;
  declare readonly hostId: string | null;
  declare readonly hostName: string | null;
  declare readonly hint: string;

  constructor(
    threadId: string,
    hostId: string | null = null,
    hostName: string | null = null,
  ) {
    super(threadId, hostId, hostName);
    this.name = 'RemoteThreadNotLoadedError';
  }
}
