import { FeedIndex, Identifier, type Topic } from '@ethersphere/bee-js';
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
import { type BoundedOutcome, boundedRequest } from '../../boundedRequest';
import {
  parseSingleOwnerChunk,
  type SingleOwnerChunk,
  singleOwnerChunkAddress,
  socBodyOf,
} from '../../singleOwnerChunk';
import { notReadyReasonOf } from './beeNodeState';

/** Bee answers this with `{"status":"ok",...}` in every version this viewer has targeted. */
const HEALTH_PATH = 'health';
const READINESS_PATH = 'readiness';
const PEERS_PATH = 'peers';

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

/** What a route answers when something in front of Bee refused it, rather than Bee itself. */
const ROUTE_REFUSED = { kind: 'route-refused' } as const;

/** What a source refusing both routes to a single-owner chunk answers, the 404 its front door gave. */
const NEITHER_ROUTE: SwarmAnswer = { kind: 'unavailable', cause: { kind: 'status', status: 404 } };

const servedWrong = (why: string): SwarmAnswer => ({
  kind: 'unavailable',
  cause: { kind: 'network', error: new Error(`the gateway served a single-owner chunk ${why}`) },
});

interface BeeHttpProviderOptions {
  /** A Bee API base: an http or https address, or a path on this site such as `/bee` that the site proxies to Bee. */
  readonly baseUrl: string;
  /** Injected by tests. The global `fetch` otherwise. */
  readonly fetcher?: typeof fetch;
  /** The page's own origin, which a gateway given as a path on this site is resolved against for a URL. */
  readonly pageOrigin?: string;
}

const isSuccess = (status: number) => status >= 200 && status < 300;

/** Bee answers every error as JSON with a numeric `code` and a `message`, its own 404 included. */
function isBeeError(body: Uint8Array | null): boolean {
  if (body === null) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const { code, message } = parsed as { code?: unknown; message?: unknown };
    return typeof code === 'number' && typeof message === 'string';
  } catch {
    return false;
  }
}

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
  private socRouteRefused = false;

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

  /**
   * A single-owner chunk's body, from `/soc`, or by its chunk address where this source refuses that route. Public
   * gateways answer `/soc` with a plain `Not Found` from their front door, and serve the same chunk at `/chunks`. A
   * refusal is remembered, so later reads go to the chunk address first, and forgotten when that route is refused
   * too, so a source that stopped refusing `/soc` is read there again.
   */
  async readSoc(owner: string, identifier: string, options?: ReadOptions): Promise<SwarmAnswer> {
    if (!this.socRouteRefused) {
      const answer = await this.readRoute(`soc/${owner}/${identifier}`, options, ABSENT);
      if (answer.kind !== ROUTE_REFUSED.kind) {
        return answer;
      }
      this.socRouteRefused = true;
    }
    return this.readSocByAddress(owner, identifier, options);
  }

  /**
   * The chunk is checked to be the owner's before its body is given, because the route serves whatever is stored at
   * an address: the signature must recover an owner who, with the identifier, makes the address asked.
   */
  private async readSocByAddress(owner: string, identifier: string, options?: ReadOptions): Promise<SwarmAnswer> {
    let address: string;
    try {
      address = singleOwnerChunkAddress(new Identifier(identifier), owner);
    } catch {
      return UNSUPPORTED;
    }
    const answer = await this.readRoute(`chunks/${address}`, options, ABSENT_CHUNK);
    if (answer.kind === ROUTE_REFUSED.kind) {
      this.socRouteRefused = false;
      return NEITHER_ROUTE;
    }
    if (answer.kind !== 'content') {
      return answer;
    }
    let chunk: SingleOwnerChunk;
    try {
      chunk = parseSingleOwnerChunk(answer.bytes, address);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return servedWrong(`that could not be checked as ${owner}'s, since ${why}`);
    }
    return socBodyOf(chunk, answer, (root) => this.readBytes(root, options), servedWrong);
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
   * lines against the playlist's own URL, which here is a `memory:` or a `swarm://` URI. A picture's is
   * left as the gateway was given, because the page itself loads it. Its reference is encoded because
   * it comes from the stream list, external input, and its trailing slash makes Bee serve the uploaded
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

  /**
   * Asks `/health`, and beside it `/readiness` and `/peers`, so a node that is there and cannot serve
   * reads yet is told apart in the same round trip. When nothing readable comes back, a second request
   * with `mode: 'no-cors'` asks whether anything answered at all: a browser answers that one opaquely
   * whatever the node's CORS settings, and rejects it only when nothing is there.
   */
  async probe(options: ReadOptions = {}): Promise<ProbeResult> {
    const startedAt = Date.now();
    const ask = (path: string, init?: RequestInit) =>
      boundedRequest(`${this.baseUrl}/${path}`, {
        fetcher: this.fetcher,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        signal: options.signal,
        readsBody: isSuccess,
        init,
      });
    const [health, readiness, peers] = await Promise.all([ask(HEALTH_PATH), ask(READINESS_PATH), ask(PEERS_PATH)]);
    switch (health.kind) {
      case 'response': {
        const { response, body } = health;
        if (!isSuccess(response.status)) {
          return { kind: 'rejected', status: response.status };
        }
        if (!looksLikeBeeHealth(new TextDecoder().decode(body ?? new Uint8Array()))) {
          return { kind: 'not-swarm' };
        }
        const reason = notReadyReasonOf(body, readiness, peers);
        return reason === null ? { kind: 'ok', elapsedMs: Date.now() - startedAt } : { kind: 'not-ready', reason };
      }
      case 'timed-out':
        return { kind: 'timed-out' };
      case 'aborted':
        return { kind: 'unreachable' };
      case 'failed': {
        const opaque = await ask(HEALTH_PATH, { mode: 'no-cors' });
        return opaque.kind === 'response' ? { kind: 'refuses-this-site' } : { kind: 'unreachable' };
      }
    }
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  private async read(path: string, options: ReadOptions = {}, absent = ABSENT): Promise<SwarmAnswer> {
    return answerOfOutcome(await this.boundedGet(path, options, isSuccess), options, absent);
  }

  /**
   * {@link read}, except a 404 that is not Bee's own JSON error answers {@link ROUTE_REFUSED}. A public gateway's
   * front door answers a route it does not pass to Bee with a plain `Not Found`, which would otherwise read as content
   * that is not there. The 404's body is read to tell the two apart, which costs a gateway that serves the route only
   * the few bytes of Bee's error, never another request.
   */
  private async readRoute(
    path: string,
    options: ReadOptions = {},
    absent: AbsentStatuses,
  ): Promise<SwarmAnswer | typeof ROUTE_REFUSED> {
    const outcome = await this.boundedGet(path, options, (status) => isSuccess(status) || status === NOT_FOUND);
    if (outcome.kind === 'response' && outcome.response.status === NOT_FOUND && !isBeeError(outcome.body)) {
      return ROUTE_REFUSED;
    }
    return answerOfOutcome(outcome, options, absent);
  }

  private boundedGet(path: string, options: ReadOptions, readsBody: (status: number) => boolean) {
    return boundedRequest(`${this.baseUrl}/${path}`, {
      fetcher: this.fetcher,
      timeoutMs: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
      signal: options.signal,
      readsBody,
    });
  }
}

function answerOfOutcome(outcome: BoundedOutcome, options: ReadOptions, absent: AbsentStatuses): SwarmAnswer {
  switch (outcome.kind) {
    case 'aborted':
      return ABORTED;
    case 'timed-out':
      return {
        kind: 'unavailable',
        cause: { kind: 'timeout', timeoutMs: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS },
      };
    case 'failed':
      return { kind: 'unavailable', cause: { kind: 'network', error: outcome.error } };
    case 'response':
      return answerOf(outcome.response, outcome.body, absent);
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
