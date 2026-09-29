export { RemoteThreadNotLoadedError } from '../codex/remote-control.js';

/** Desktop opened the route but requires explicit unarchive before interaction. */
export class ArchivedThreadError extends Error {
  readonly code = 'ARCHIVED_THREAD' as const;
  readonly reason = 'archived-thread' as const;
  readonly delivery = 'rejected' as const;
  readonly threadId: string;

  constructor(threadId: string) {
    super(`ChatGPT Desktop thread ${JSON.stringify(threadId)} is archived. Read it through app-server, or pass unarchive: true on send to unarchive before sending.`);
    this.name = 'ArchivedThreadError';
    this.threadId = threadId;
  }
}

/** Sending would replace an operator's unsent composer draft. */
export class ComposerDraftError extends Error {
  readonly code = 'COMPOSER_HAS_DRAFT' as const;
  readonly reason = 'composer-has-draft' as const;
  readonly delivery = 'rejected' as const;

  constructor() {
    super('ChatGPT Desktop composer contains an unsent draft; inspect it in Desktop before sending.');
    this.name = 'ComposerDraftError';
  }
}

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
