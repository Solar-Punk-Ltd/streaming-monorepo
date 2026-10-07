/** How one bounded request ended. Never a rejection, so every caller sorts the same three endings. */
export type BoundedOutcome =
  | { readonly kind: 'response'; readonly response: Response; readonly body: Uint8Array | null }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'failed'; readonly error: unknown };

interface BoundedRequestOptions {
  readonly fetcher: typeof fetch;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Whether a response with this status has its body read inside the window. */
  readonly readsBody: (status: number) => boolean;
}

/**
 * One GET whose window covers the headers and the body together, composing the caller's signal
 * rather than replacing it, and answering instead of throwing: a gateway that sends headers and
 * withholds the body is still bounded, and a caller who cancelled is told so even if the window ran
 * out in the same tick.
 *
 * Built from `AbortController` and `setTimeout` rather than `AbortSignal.timeout` (Safari 16) and
 * `AbortSignal.any` (Safari 17.4), so every read works on the build target's Safari 14.
 */
export async function boundedRequest(url: string, options: BoundedRequestOptions): Promise<BoundedOutcome> {
  const { fetcher, timeoutMs, signal, readsBody } = options;
  if (signal?.aborted) {
    return { kind: 'aborted' };
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetcher(url, { signal: controller.signal });
    const body = readsBody(response.status) ? new Uint8Array(await response.arrayBuffer()) : null;
    return { kind: 'response', response, body };
  } catch (error) {
    if (signal?.aborted) {
      return { kind: 'aborted' };
    }
    return timedOut ? { kind: 'timed-out' } : { kind: 'failed', error };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
