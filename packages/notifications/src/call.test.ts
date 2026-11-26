/**
 * The one call every channel makes: where it goes, what it follows and what it reads, when it gives up, and how its
 * failure reads. A fake fetch stands in for the network, and the deadline runs on node:test's mocked clock.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { callService, serviceWords, type ServiceCall } from './call.js';
import { NotificationSendError, type NotificationFetch } from './channel.js';
import {
  NOTIFICATION_ANSWER_MAX_BYTES,
  NOTIFICATION_CALL_TIMEOUT_MS,
  NOTIFICATION_SERVICE_WORDS_MAX_LENGTH,
  TELEGRAM_API_HOST,
} from './rules.js';

const TOKEN = `1234567890:${'A'.repeat(35)}`;
const KEY = TOKEN.slice(TOKEN.indexOf(':') + 1);
const ADDRESS = `https://api.telegram.org/bot${TOKEN}/sendMessage`;

const call: ServiceCall = {
  service: 'Telegram',
  host: TELEGRAM_API_HOST,
  path: `/bot${TOKEN}/sendMessage`,
  body: { chat_id: '-42', text: 'Top-ups coming up' },
  secrets: [TOKEN, KEY],
};

// @ts-expect-error A call goes to one of the hosts rules.ts fixes, and to no other.
const _elsewhere: ServiceCall = { ...call, host: 'example.org' };

interface Request {
  url: string;
  init: RequestInit;
}

/** A fetch that keeps each request and answers it with what `answer` makes. */
function fakeFetch(answer: () => Response): { fetch: NotificationFetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetch: NotificationFetch = (input, init = {}) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(answer());
  };
  return { fetch, requests };
}

/** A fetch that never answers, and fails as the real one does once its signal aborts. */
function silentFetch(): { fetch: NotificationFetch; called: Promise<void> } {
  let markCalled: () => void = () => undefined;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const fetch: NotificationFetch = (_input, init) => {
    markCalled();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The call was aborted.', 'AbortError')), {
        once: true,
      });
    });
  };
  return { fetch, called };
}

/** An answer that never ends, a kilobyte of `x` at a time, counting what was taken from it. */
function endlessBody(): { body: ReadableStream<Uint8Array>; taken: () => number; cancelled: () => boolean } {
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  let taken = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      taken += chunk.byteLength;
      controller.enqueue(chunk.slice());
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, taken: () => taken, cancelled: () => cancelled };
}

/** An answer that sends `first` and then nothing more, without ending. */
function stalledBody(first: string): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(first));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, cancelled: () => cancelled };
}

/** Lets every callback that is due run, on the real clock. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The error a call that has to fail rejects with. */
async function failure(sending: Promise<unknown>): Promise<NotificationSendError> {
  try {
    await sending;
  } catch (error) {
    assert.ok(error instanceof NotificationSendError, String(error));
    return error;
  }
  assert.fail('The service took it.');
}

describe('a call to a service', () => {
  it('posts its body as JSON to the service on its own host, following no redirect', async () => {
    const { fetch, requests } = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    await callService({ ...call, headers: { 'x-extra': 'kept' } }, fetch);
    assert.equal(requests.length, 1);
    const [{ url, init }] = requests;
    assert.equal(url, ADDRESS);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
      'content-type': 'application/json',
      'x-extra': 'kept',
    });
    assert.deepEqual(JSON.parse(String(init.body)), call.body);
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('goes to no other host, nor to another host through its path, and calls nothing then', async () => {
    const { fetch, requests } = fakeFetch(() => new Response(null, { status: 200 }));
    for (const path of ['//example.org/x', '/\\example.org/x', 'https://example.org/x', 'sendMessage']) {
      const error = await failure(callService({ ...call, path }, fetch));
      assert.equal(error.message, "Telegram was not called: its address is not on the service's own host.", path);
      assert.equal(error.status, null);
    }
    await failure(callService(_elsewhere, fetch));
    assert.equal(requests.length, 0);
  });

  it('is taken on a 2xx status, without its answer being read', async () => {
    const answer = endlessBody();
    const { fetch } = fakeFetch(() => new Response(answer.body, { status: 201 }));
    await callService(call, fetch);
    await flush();
    assert.equal(answer.cancelled(), true);
  });

  it('follows no redirect, and names no address it was sent to', async () => {
    const { fetch, requests } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://example.org/elsewhere' } }),
    );
    const error = await failure(callService(call, fetch));
    assert.equal(error.message, 'Telegram answered with a redirect, status 302, which is not followed.');
    assert.equal(error.status, 302);
    assert.equal(requests.length, 1);
  });

  it(`gives up once ${NOTIFICATION_CALL_TIMEOUT_MS} ms pass with no answer`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { fetch, called } = silentFetch();
    const sending = callService(call, fetch);
    let settled = false;
    void sending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await called;
    t.mock.timers.tick(NOTIFICATION_CALL_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const error = await failure(sending);
    assert.equal(error.message, 'Telegram did not answer within 10 seconds.');
    assert.equal(error.status, null);
  });

  it('gives up at the same deadline on an answer that stops coming in, and keeps its status', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const answer = stalledBody('Bad Gate');
    const { fetch } = fakeFetch(() => new Response(answer.body, { status: 502 }));
    const sending = callService(call, fetch);
    await flush();
    t.mock.timers.tick(NOTIFICATION_CALL_TIMEOUT_MS);
    const error = await failure(sending);
    assert.equal(error.message, 'Telegram answered with status 502: Bad Gate.');
    assert.equal(error.status, 502);
    assert.equal(answer.cancelled(), true);
  });

  it(`reads at most ${NOTIFICATION_ANSWER_MAX_BYTES} bytes of an answer`, async () => {
    const answer = endlessBody();
    const { fetch } = fakeFetch(() => new Response(answer.body, { status: 500 }));
    const error = await failure(callService(call, fetch));
    assert.ok(answer.taken() <= NOTIFICATION_ANSWER_MAX_BYTES + 2 * 1024, `${answer.taken()} bytes were taken`);
    assert.equal(answer.cancelled(), true);
    assert.equal(
      error.message,
      `Telegram answered with status 500: ${'x'.repeat(NOTIFICATION_SERVICE_WORDS_MAX_LENGTH - 1)}…`,
    );
  });

  it('names a network failure by its code, and keeps nothing else of it', async () => {
    const failing: NotificationFetch = () =>
      Promise.reject(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${TELEGRAM_API_HOST}`), { code: 'ENOTFOUND' }),
        }),
      );
    const error = await failure(callService(call, failing));
    assert.equal(error.message, 'Telegram could not be reached (ENOTFOUND).');
    assert.equal(error.status, null);
    assert.equal(error.cause, undefined);
  });
});

describe("a failure's sentence", () => {
  it("repeats the service's own explanation", () => {
    const telegram = '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}';
    assert.equal(serviceWords(telegram, []), 'Bad Request: chat not found');
    assert.equal(serviceWords('{"code":"unauthorized","message":"Key not found"}', []), 'Key not found');
    assert.equal(serviceWords('no_service', []), 'no_service');
    assert.equal(serviceWords('{"error":"invalid_payload"}', []), 'invalid_payload');
    assert.equal(serviceWords('{"status":"down"}', []), '{"status":"down"}');
    assert.equal(serviceWords('', []), '');
  });

  it(`holds printable characters alone, ${NOTIFICATION_SERVICE_WORDS_MAX_LENGTH} at most`, () => {
    assert.equal(serviceWords('Bad\r\n\tthing\u0000 here‮ now​', []), 'Bad thing here now');
    const long = serviceWords('word '.repeat(100), []);
    assert.equal(Array.from(long).length, NOTIFICATION_SERVICE_WORDS_MAX_LENGTH);
    assert.ok(long.endsWith('word…'), long);
    const faces = serviceWords('😀'.repeat(300), []);
    assert.equal(Array.from(faces).length, NOTIFICATION_SERVICE_WORDS_MAX_LENGTH);
    assert.equal(/\p{Cs}/u.test(faces), false);
  });

  it('never repeats the secret or the address that was called', async () => {
    const echoes = [
      `{"ok":false,"error_code":404,"description":"Not Found: ${ADDRESS}"}`,
      `Unknown bot ${TOKEN}`,
      `{"ok":false,"error_code":401,"description":"The key ${KEY} is refused"}`,
      `{"url":"${ADDRESS.replaceAll('/', '\\/')}"}`,
    ];
    for (const echo of echoes) {
      const { fetch } = fakeFetch(() => new Response(echo, { status: 404 }));
      const error = await failure(callService(call, fetch));
      for (const secret of [TOKEN, KEY, ADDRESS, `${TELEGRAM_API_HOST}/bot`]) {
        assert.equal(error.message.includes(secret), false, error.message);
      }
      assert.match(error.message, /\[hidden\]/);
    }
  });

  it('keeps nothing of a network failure whose words hold the address', async () => {
    const failing: NotificationFetch = () => Promise.reject(new TypeError(`Failed to parse URL from ${ADDRESS}`));
    const error = await failure(callService(call, failing));
    assert.equal(error.message, 'Telegram could not be reached.');
    assert.equal(inspect(error, { showHidden: true, depth: 10 }).includes(KEY), false);
  });
});
