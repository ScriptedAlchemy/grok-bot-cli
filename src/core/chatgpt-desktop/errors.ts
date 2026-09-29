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
 * app-server. SSH remoting is a follow-up — this error only names the owner.
 */
export class RemoteThreadNotLoadedError extends Error {
  readonly code = 'REMOTE_THREAD_NOT_LOADED' as const;
  readonly delivery = 'rejected' as const;
  readonly reason = 'remote-thread-not-loaded' as const;
  readonly threadId: string;
  readonly hostId: string | null;

  constructor(threadId: string, hostId: string | null = null) {
    const owner = hostId
      ? `owned by remote-control host ${JSON.stringify(hostId)}`
      : 'owned by a remote-control host (hostId unknown; check ~/.codex/.codex-global-state.json)';
    super(
      `Codex thread ${JSON.stringify(threadId)} is not loaded on the local app-server; ` +
        `${owner}. SSH remoting is not implemented in this adapter yet.`,
    );
    this.name = 'RemoteThreadNotLoadedError';
    this.threadId = threadId;
    this.hostId = hostId;
  }
}
