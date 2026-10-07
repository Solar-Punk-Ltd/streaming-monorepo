import { describe, expect, it } from 'vitest';

import { loadUrl, SwarmClient } from '../../src/swarm/client';
import { ScriptedProvider } from '../helpers/scriptedProvider';

const URL_GIVEN = 'https://gateway.example.com/bytes/' + 'ab'.repeat(32);

const answering =
  (response: () => Response | Promise<Response>): typeof fetch =>
  async () =>
    response();

describe('loading a URL the client gave', () => {
  it('answers content with the bytes the browser would load', async () => {
    const answer = await loadUrl(URL_GIVEN, { fetcher: answering(() => new Response(new Uint8Array([1, 2]))) });

    expect(answer).toMatchObject({ kind: 'content', bytes: new Uint8Array([1, 2]) });
  });

  it('answers not found for a 404, rate limited for a 429, and unavailable for any other failing status', async () => {
    const status = (code: number) => answering(() => new Response('', { status: code }));

    expect((await loadUrl(URL_GIVEN, { fetcher: status(404) })).kind).toBe('not-found');
    expect((await loadUrl(URL_GIVEN, { fetcher: status(429) })).kind).toBe('rate-limited');
    expect(await loadUrl(URL_GIVEN, { fetcher: status(502) })).toEqual({
      kind: 'unavailable',
      cause: { kind: 'status', status: 502 },
    });
  });

  it('answers unavailable for no answer at all, and for none inside the window', async () => {
    const refused = await loadUrl(URL_GIVEN, {
      fetcher: answering(() => Promise.reject(new TypeError('Failed to fetch'))),
    });
    const hung = await loadUrl(URL_GIVEN, {
      timeoutMs: 10,
      fetcher: (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });

    expect(refused).toMatchObject({ kind: 'unavailable', cause: { kind: 'network' } });
    expect(hung).toEqual({ kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: 10 } });
  });
});

describe("the client's probe", () => {
  it('asks the provider every feature reads from first', async () => {
    const chosen = new ScriptedProvider('chosen');
    const client = new SwarmClient({ chosen: { id: 'chosen', provider: chosen } });

    expect(await client.probe()).toEqual({ kind: 'ok', elapsedMs: 0 });
  });
});
