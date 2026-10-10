import { ABORTED, type SwarmAnswer } from './answers';
import { boundedRequest } from './boundedRequest';
import { DEFAULT_READ_TIMEOUT_MS, type ReadOptions } from './provider';

const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;

export interface UrlLoadOptions extends ReadOptions {
  /** Injected by tests. The global `fetch` otherwise. */
  readonly fetcher?: typeof fetch;
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/**
 * Loads a URL the client gave, a segment or a picture, the way the browser or hls.js would, and answers
 * as a read does. The player and the pages never call this, they hand the URL to the browser. It is how
 * the node picker's Test shows that what the browser would load is really there.
 */
export async function loadUrl(url: string, options: UrlLoadOptions = {}): Promise<SwarmAnswer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const outcome = await boundedRequest(url, {
    fetcher: options.fetcher ?? fetch,
    timeoutMs,
    signal: options.signal,
    readsBody: isSuccess,
  });
  switch (outcome.kind) {
    case 'aborted':
      return ABORTED;
    case 'timed-out':
      return { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs } };
    case 'failed':
      return { kind: 'unavailable', cause: { kind: 'network', error: outcome.error } };
    case 'response': {
      const { status } = outcome.response;
      if (status === NOT_FOUND) {
        return { kind: 'not-found', serverTimeMs: null };
      }
      if (status === TOO_MANY_REQUESTS) {
        return { kind: 'rate-limited', retryAfterMs: null, serverTimeMs: null };
      }
      return outcome.body === null
        ? { kind: 'unavailable', cause: { kind: 'status', status } }
        : { kind: 'content', bytes: outcome.body, feedIndex: null, serverTimeMs: null };
    }
  }
}
