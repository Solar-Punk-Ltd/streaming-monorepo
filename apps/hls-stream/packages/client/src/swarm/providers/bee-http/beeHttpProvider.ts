import { FeedIndex, type Topic } from '@ethersphere/bee-js';
import { makeFeedIdentifier, nextFeedRequest, resolvedFeedIndex } from '@swarm-hls-stream/shared';

import { ABORTED, type SwarmAnswer, UNSUPPORTED } from '../../answers';
import {
  DEFAULT_READ_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  type ProbeResult,
  type ProviderCapabilities,
  type ProviderStatus,
  type ReadOptions,
  type SwarmProvider,
  type UrlUse,
} from '../../provider';
import { boundedRequest } from './boundedRequest';

/** Bee answers this with `{"status":"ok",...}` in every version this viewer has targeted. */
const HEALTH_PATH = 'health';

/** The longest a node's `Retry-After` may keep a provider paused, so one answer cannot stall a feed for an hour. */
export const LONGEST_RETRY_AFTER_MS = 60_000;

const NOT_FOUND = 404;
const TOO_MANY_REQUESTS = 429;
/** What Bee answers `GET /chunks` with for a chunk it could not find, one never written among them. */
const CHUNK_NOT_RETRIEVED = 500;

/** The statuses a read takes as content that is not there. */
type AbsentStatuses = ReadonlySet<number>;

const ABSENT: AbsentStatuses = new Set([NOT_FOUND]);
const ABSENT_CHUNK: AbsentStatuses = new Set([NOT_FOUND, CHUNK_NOT_RETRIEVED]);

const CAPABILITIES: ProviderCapabilities = {
  feedHead: true,
  feedEntry: true,
  soc: true,
  chunk: true,
  bytes: true,
  urls: true,
  inTab: false,
};

const READY: ProviderStatus = { state: 'ready' };

export interface BeeHttpProviderOptions {
  /** A Bee API base: an http or https address, or a path on this site such as `/bee` that the site proxies to Bee. */
  readonly baseUrl: string;
  /** Injected by tests. The global `fetch` otherwise. */
  readonly fetcher?: typeof fetch;
  /** The page's own origin, which a gateway given as a path on this site is resolved against for a URL. */
  readonly pageOrigin?: string;
}

const isSuccess = (status: number) => status >= 200 && status < 300;

function dateOf(headers: Headers): number | null {
  const date = headers.get('date');
  const ms = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The wait `Retry-After` asks for, as seconds or as an HTTP date, never longer than
 * {@link LONGEST_RETRY_AFTER_MS}. A date is read against the answer's own `Date` when it has one,
 * because the two come from the same clock and the viewer's may be off. A value that is negative or
 * too large to be a number is read as no wait named.
 */
function retryAfterMsOf(headers: Headers, serverTimeMs: number | null): number | null {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) {
    return null;
  }
  if (/^-?\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? cappedRetryAfterMs(seconds * 1000) : null;
  }
  const until = Date.parse(raw);
  return Number.isFinite(until) ? cappedRetryAfterMs(Math.max(0, until - (serverTimeMs ?? Date.now()))) : null;
}

function cappedRetryAfterMs(ms: number): number {
  return Math.min(ms, LONGEST_RETRY_AFTER_MS);
}

function looksLikeBeeHealth(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { status?: unknown }).status === 'string';
  } catch {
    return false;
  }
}

function currentPageOrigin(): string {
  return typeof location === 'undefined' ? 'http://localhost' : location.origin;
}

/**
 * A Bee node's HTTP API, asking the same paths the viewer asked its gateway before this layer
 * existed. A 404 is content that is not there and a 429 is the node asking to be left alone. Any
 * other status that is not a success is a fault of the node, a 500 included, because Bee answers 500 for a chunk it failed to fetch from the network as well as
 * for its own trouble, and the two cannot be told apart from here. A chunk read is the one exception,
 * see {@link BeeHttpProvider.readChunk}.
 */
export class BeeHttpProvider implements SwarmProvider {
  readonly capabilities = CAPABILITIES;

  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly pageOrigin: string;

  constructor(options: BeeHttpProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Handed on as a value and called bare by `boundedRequest`, never as this object's method, which the
    // browser's fetch would refuse as an illegal invocation.
    this.fetcher = options.fetcher ?? fetch;
    this.pageOrigin = options.pageOrigin ?? currentPageOrigin();
  }

  readFeedHead(owner: string, topic: Topic, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.read(nextFeedRequest(owner, topic, null).path, options);
  }

  /**
   * A feed entry is the single-owner chunk its owner wrote under the topic and index together. An index
   * that is not a whole number from zero up names no entry, and bee-js would throw building one.
   */
  async readFeedEntry(owner: string, topic: Topic, index: number, options?: ReadOptions): Promise<SwarmAnswer> {
    if (!Number.isSafeInteger(index) || index < 0) {
      return UNSUPPORTED;
    }
    return this.readSoc(owner, makeFeedIdentifier(topic, FeedIndex.fromBigInt(BigInt(index))).toString(), options);
  }

  readSoc(owner: string, identifier: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.read(`soc/${owner}/${identifier}`, options);
  }

  /**
   * A 500 here is not there rather than a fault, because Bee answers 500 for a chunk nobody has
   * written yet, and a reader asking ahead for one would otherwise pause the node and send every
   * feature to the fallback.
   */
  readChunk(address: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.read(`chunks/${address}`, options, ABSENT_CHUNK);
  }

  readBytes(reference: string, options?: ReadOptions): Promise<SwarmAnswer> {
    return this.read(`bytes/${reference}`, options);
  }

  /**
   * A segment's URL is absolute because it is written into a playlist, and hls.js resolves a playlist's
   * lines against the playlist's own URL, which here is a blob or a `swarm://` URI. A picture's is left
   * as the gateway was given, because the page itself loads it. Its reference is encoded because it
   * comes from the stream list, external input, and its trailing slash makes Bee serve the uploaded
   * file rather than redirect.
   */
  urlFor(reference: string, use: UrlUse): string | null {
    if (use === 'thumbnail') {
      return `${this.baseUrl}/bzz/${encodeURIComponent(reference.trim())}/`;
    }
    return new URL(`${this.baseUrl}/bytes/${reference}`, this.pageOrigin).href;
  }

  status(): ProviderStatus {
    return READY;
  }

  async probe(options: ReadOptions = {}): Promise<ProbeResult> {
    const startedAt = Date.now();
    const outcome = await boundedRequest(`${this.baseUrl}/${HEALTH_PATH}`, {
      fetcher: this.fetcher,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      signal: options.signal,
      readsBody: isSuccess,
    });
    switch (outcome.kind) {
      case 'response': {
        const { response, body } = outcome;
        if (!isSuccess(response.status)) {
          return { kind: 'rejected', status: response.status };
        }
        return looksLikeBeeHealth(new TextDecoder().decode(body ?? new Uint8Array()))
          ? { kind: 'ok', elapsedMs: Date.now() - startedAt }
          : { kind: 'not-swarm' };
      }
      case 'timed-out':
        return { kind: 'timed-out' };
      case 'aborted':
      case 'failed':
        return { kind: 'unreachable' };
    }
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  private async read(path: string, options: ReadOptions = {}, absent = ABSENT): Promise<SwarmAnswer> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    const outcome = await boundedRequest(`${this.baseUrl}/${path}`, {
      fetcher: this.fetcher,
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
      case 'response':
        return answerOf(outcome.response, outcome.body, absent);
    }
  }
}

function answerOf(response: Response, body: Uint8Array | null, absent: AbsentStatuses): SwarmAnswer {
  const serverTimeMs = dateOf(response.headers);
  if (absent.has(response.status)) {
    return { kind: 'not-found', serverTimeMs };
  }
  if (response.status === TOO_MANY_REQUESTS) {
    return { kind: 'rate-limited', retryAfterMs: retryAfterMsOf(response.headers, serverTimeMs), serverTimeMs };
  }
  if (body === null) {
    return { kind: 'unavailable', cause: { kind: 'status', status: response.status } };
  }
  return { kind: 'content', bytes: body, feedIndex: resolvedFeedIndex(response.headers), serverTimeMs };
}
