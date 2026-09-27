/**
 * Node's code for a request that failed in transport, from wherever the client left it, or null for
 * a failure the node answered.
 *
 * ⛔⛔⛔ **bee-js 13 keeps no code, so this recovers the one bee-js 9 used to hand over.** bee-js 9 went
 * through axios and put Node's code on `statusText`. bee-js 13 goes through `fetch`, and measured on
 * 2026-09-27 against the same local sockets the codes moved like this:
 *
 * | Failure | bee-js 9.8.1 `statusText` | bee-js 13.1.0 |
 * |---|---|---|
 * | refused | ECONNREFUSED | message "fetch failed: connect ECONNREFUSED …" |
 * | reset before an answer | ECONNRESET | message "fetch failed: read ECONNRESET" |
 * | our own timeout | ECONNABORTED | message "The operation was aborted due to timeout" |
 * | reset mid-body | ECONNRESET | `TypeError: terminated`, `cause.code` ECONNRESET |
 * | closed mid-body | ECONNABORTED | `TypeError: terminated`, `cause.code` UND_ERR_SOCKET |
 *
 * The last two are not even `BeeResponseError`s, because bee-js 13 reads the body outside the block
 * that wraps its errors. Each row maps back to the code the left column gave, so every caller that
 * decided on those codes decides the same way now. A timeout and a closed body are ECONNABORTED
 * because that is what axios called them, and the callers were written against that name.
 *
 * An error carrying a numeric `status` is an answer and gets null, whatever its `statusText` says, so a
 * 4xx cannot be read as a transport failure by its prose.
 */
export function transportCodeOf(error: unknown): string | null {
  const carrier = error as TransportCarrier | null | undefined;
  if (carrier === null || carrier === undefined || typeof carrier.status === 'number') {
    return null;
  }

  if (typeof carrier.code === 'string') {
    return carrier.code;
  }
  if (typeof carrier.statusText === 'string' && NODE_CODE.test(carrier.statusText)) {
    return carrier.statusText;
  }

  const causeCode = carrier.cause?.code;
  if (typeof causeCode === 'string') {
    return causeCode === UNDICI_SOCKET_CLOSED ? AXIOS_ABORTED : causeCode;
  }

  if (carrier.name === 'TimeoutError' || TIMED_OUT_TEXT.test(carrier.message ?? '')) {
    return AXIOS_ABORTED;
  }

  return FETCH_FAILED_TEXT.exec(carrier.message ?? '')?.[1] ?? null;
}

/**
 * What went wrong, in words, with the transport code added when the words do not already name it.
 *
 * ⛔ Every start gate puts this inside a sentence of its own, and `NodeWait` then has only that text to
 * decide on. bee-js 13's "terminated" and "The operation was aborted due to timeout" name no code, so
 * without it a node that dropped a body or went silent read as a genuine fault and ended the boot
 * instead of being waited on.
 */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = transportCodeOf(error);
  return code === null || message.includes(code) ? message : `${message} (${code})`;
}

interface TransportCarrier {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly statusText?: unknown;
  readonly name?: unknown;
  readonly message?: string;
  readonly cause?: { readonly code?: unknown };
}

/** Node's own codes are upper case and start with E, as ECONNRESET does, or ERR_ as ERR_CANCELED does. */
const NODE_CODE = /^(E[A-Z]+|ERR_[A-Z_]+)$/;

/** undici's code for a socket the other side closed while a body was still arriving. */
const UNDICI_SOCKET_CLOSED = 'UND_ERR_SOCKET';

/** axios's code for a request it gave up on, its own timeout and a body cut short alike. */
const AXIOS_ABORTED = 'ECONNABORTED';

/** The message a `TimeoutError` from `AbortSignal.timeout` carries, which bee-js 13 keeps. */
const TIMED_OUT_TEXT = /aborted due to timeout/i;

/** bee-js 13 folds a failed fetch's cause into its message, "fetch failed: connect ECONNREFUSED …". */
const FETCH_FAILED_TEXT = /^fetch failed: .*?\b(E[A-Z]+)\b/;

/**
 * Node's error codes for a request that reached bee and then lost the transfer, as opposed to one
 * that never arrived: the uploader's own timeout and a body closed early, which are ECONNABORTED, and
 * a reset, which is ECONNRESET.
 *
 * ECONNREFUSED, ENOTFOUND and the rest deliberately stay out: those say the node was never there.
 */
const TRANSFER_LOST_CODES = new Set([AXIOS_ABORTED, 'ECONNRESET']);

/**
 * A request that reached the node and lost the response on the way back.
 *
 * ⛔ Read through {@link transportCodeOf} rather than off `statusText`, and not only for a
 * `BeeResponseError`. Under bee-js 13 a body lost mid-way arrives as fetch's own `TypeError`, and no
 * failure carries its code where bee-js 9 put it, so the old test matched nothing at all.
 */
export function isTransferLost(error: unknown): boolean {
  const code = transportCodeOf(error);
  return code !== null && TRANSFER_LOST_CODES.has(code);
}
