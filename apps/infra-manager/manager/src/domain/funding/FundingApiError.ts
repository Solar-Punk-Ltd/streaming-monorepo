import { FUNDING_ERROR_STATUS, type FundingErrorCode } from '@streaming-monorepo/contracts';

/**
 * A refusal of the funding API under /api/admin-funding, answered as `{ error, message }` with the status the
 * contract gives its code (`FUNDING_ERROR_STATUS` in `packages/contracts`). The message is a sentence for the web2
 * admin's operator and never carries a token, a key, a node's address or an RPC endpoint.
 */
export class FundingApiError extends Error {
  readonly status: number;

  constructor(
    readonly code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FundingApiError';
    this.status = FUNDING_ERROR_STATUS[code];
  }
}
