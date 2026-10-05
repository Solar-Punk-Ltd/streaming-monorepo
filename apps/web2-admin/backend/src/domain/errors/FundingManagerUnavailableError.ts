/**
 * The manager's funding API could not be read for a pin or a send, so nothing was pinned, signed or written.
 * `message` is the admin's own sentence, never the manager's address or token. The API answers 502.
 */
export class FundingManagerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundingManagerUnavailableError';
  }
}
