import { FeedIndex, Topic } from '@ethersphere/bee-js';
import { feedSlotPath, makeFeedIdentifier, nextFeedRequest } from '@swarm-hls-stream/shared';

/**
 * A Bee node in memory that answers the paths the Bee HTTP provider asks, with the headers Bee sends,
 * so a provider under test reaches no network. Every name in it is made up.
 */

/** The gateway base the fake answers under, a viewer's `/bee` proxy on a page of its own. */
export const FAKE_GATEWAY = 'http://viewer.example/bee';

const UTF8 = new TextEncoder();

export const FAKE_OWNER = '1'.repeat(40);
export const FAKE_TOPIC = Topic.fromString('fake-gateway-feed');
/** The index the fake feed's head resolves to, which Bee sends zero-padded in hexadecimal. */
export const FAKE_HEAD_INDEX = 5;
/** The `Date` every answer carries, Wed, 07 Oct 2026 12:00:00 GMT. */
export const FAKE_DATE_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
export const FAKE_SOC_IDENTIFIER = 'a1'.repeat(32);
export const FAKE_CHUNK = 'b2'.repeat(32);
export const FAKE_REFERENCE = 'c3'.repeat(32);

/** What the fake holds, by the path under {@link FAKE_GATEWAY}. */
interface Stored {
  readonly body: Uint8Array;
  readonly headers: Record<string, string>;
}

function stored(): Map<string, Stored> {
  const date = new Date(FAKE_DATE_MS).toUTCString();
  const entries = new Map<string, Stored>();
  entries.set(nextFeedRequest(FAKE_OWNER, FAKE_TOPIC, null).path, {
    body: UTF8.encode('the feed head'),
    headers: { date, 'swarm-feed-index': FAKE_HEAD_INDEX.toString(16).padStart(16, '0') },
  });
  for (let index = 0; index <= FAKE_HEAD_INDEX; index += 1) {
    entries.set(feedSlotPath(FAKE_OWNER, FAKE_TOPIC, FeedIndex.fromBigInt(BigInt(index))), {
      body: UTF8.encode(`feed entry ${index}`),
      headers: { date },
    });
  }
  entries.set(`soc/${FAKE_OWNER}/${FAKE_SOC_IDENTIFIER}`, { body: UTF8.encode('a time marker'), headers: { date } });
  entries.set(`chunks/${FAKE_CHUNK}`, { body: new Uint8Array([1, 2, 3, 4]), headers: { date } });
  entries.set(`bytes/${FAKE_REFERENCE}`, { body: new Uint8Array([0x47, 0, 1, 2]), headers: { date } });
  return entries;
}

const STORED = stored();

/** The body the fake serves at a path, which a test compares a provider's content against. */
export function fakeBody(path: string): Uint8Array {
  const answer = STORED.get(path);
  if (!answer) {
    throw new Error(`the fake gateway holds nothing at ${path}`);
  }
  return answer.body;
}

/** The identifier a feed entry of the fake feed is stored under, as a single-owner chunk. */
export function fakeEntryIdentifier(index: number): string {
  return makeFeedIdentifier(FAKE_TOPIC, FeedIndex.fromBigInt(BigInt(index))).toString();
}

/** Bee's own answer for something it does not hold. */
function notFound(): Response {
  return new Response(JSON.stringify({ code: 404, message: 'Not Found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Every URL a fake was asked, in order. */
export interface AskedLog {
  readonly urls: string[];
}

/** Answers what the fake holds under {@link FAKE_GATEWAY} and 404 for anything else. */
export function fakeBeeFetch(log: AskedLog = { urls: [] }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    log.urls.push(url);
    const answer = url.startsWith(`${FAKE_GATEWAY}/`) ? STORED.get(url.slice(FAKE_GATEWAY.length + 1)) : undefined;
    if (!answer) {
      return notFound();
    }
    return new Response(answer.body.slice(), { status: 200, headers: answer.headers });
  }) as typeof fetch;
}

/** Accepts every request and answers none, until the request's signal gives up on it. */
export function silentFetch(log: AskedLog = { urls: [] }): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    log.urls.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(abortError()));
    });
  }) as typeof fetch;
}

/** Fails every request the way a browser reports a closed port, a DNS miss or a CORS refusal. */
export function faultyFetch(log: AskedLog = { urls: [] }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    log.urls.push(String(input));
    throw new TypeError('Failed to fetch');
  }) as typeof fetch;
}

/** Answers every request with a status and the headers given. */
export function answeringFetch(status: number, headers: Record<string, string> = {}, body = ''): typeof fetch {
  return (async () => new Response(body, { status, headers })) as typeof fetch;
}
