import { describe, expect, it } from 'vitest';

import { MINIMUM_BEE_VERSION } from '../../src/swarm/providers/bee-http/beeNodeState';
import { BeeHttpProvider } from '../../src/swarm/providers/bee-http/beeHttpProvider';

type Path = 'health' | 'readiness' | 'peers';
type Answers = Partial<Record<Path, Response | Error>>;

/** A node answering each of the three paths as told, a 404 for anything it was not told about. */
function node(answers: Answers, noCors: 'answers' | 'refuses' = 'refuses') {
  const asked: { url: string; mode: RequestMode | undefined }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, mode: init?.mode });
    if (init?.mode === 'no-cors') {
      if (noCors === 'refuses') {
        throw new TypeError('Failed to fetch');
      }
      return new Response(null);
    }
    const answer = answers[url.slice(url.lastIndexOf('/') + 1) as Path];
    if (answer instanceof Error) {
      throw answer;
    }
    return answer?.clone() ?? new Response('', { status: 404 });
  }) as typeof fetch;
  return { asked, probe: () => new BeeHttpProvider({ baseUrl: 'http://localhost:1633', fetcher }).probe() };
}

const health = (version: string) => Response.json({ status: 'ok', version, apiVersion: '7.3.0' });
const READY = Response.json({ status: 'ready', version: '2.8.2', apiVersion: '7.3.0' });
const NOT_READY = Response.json({ status: 'notReady', version: '2.8.2', apiVersion: '7.3.0' }, { status: 400 });
const PEERS = Response.json({ peers: [{ address: 'ab'.repeat(32), fullNode: true }] });

describe("what a Bee node's health, readiness and peers say before a viewer switches to it", () => {
  it('asks the three paths under the address in one round', async () => {
    const { asked, probe } = node({ health: health('2.8.2'), readiness: READY, peers: PEERS });

    expect(await probe()).toMatchObject({ kind: 'ok' });
    expect(asked.map(({ url }) => url).toSorted()).toEqual([
      'http://localhost:1633/health',
      'http://localhost:1633/peers',
      'http://localhost:1633/readiness',
    ]);
  });

  it('finds a node still starting by its readiness, which Bee answers 400 until every part is up', async () => {
    expect(await node({ health: health('2.8.2'), readiness: NOT_READY, peers: PEERS }).probe()).toEqual({
      kind: 'not-ready',
      reason: { kind: 'starting' },
    });
  });

  it('finds a node still starting by its peers, which Bee answers 503 until its full API is on', async () => {
    const peers = Response.json({ code: 503, message: 'Node is syncing.' }, { status: 503 });
    expect(await node({ health: health('2.8.2'), readiness: READY, peers }).probe()).toEqual({
      kind: 'not-ready',
      reason: { kind: 'starting' },
    });
  });

  it('finds a node with no peers, which cannot fetch anything from Swarm', async () => {
    const peers = Response.json({ peers: [] });
    expect(await node({ health: health('2.8.2'), readiness: READY, peers }).probe()).toEqual({
      kind: 'not-ready',
      reason: { kind: 'no-peers' },
    });
  });

  it('takes a peer list of null as unread rather than empty, since Bee 2.8.2 always sends an array', async () => {
    const peers = Response.json({ peers: null });
    expect(await node({ health: health('2.8.2'), readiness: READY, peers }).probe()).toMatchObject({ kind: 'ok' });
  });

  it.each(['2.2.0', '2.2.9-a1b2c3d4', '1.18.2'])('finds version %s older than the viewer needs', async (version) => {
    expect(await node({ health: health(version), readiness: READY, peers: PEERS }).probe()).toEqual({
      kind: 'not-ready',
      reason: { kind: 'too-old', version, needed: MINIMUM_BEE_VERSION },
    });
  });

  it.each(['2.3.0', '2.8.2-rc1-0a1b2c3d', '3.0.0'])('takes version %s', async (version) => {
    expect(await node({ health: health(version), readiness: READY, peers: PEERS }).probe()).toMatchObject({
      kind: 'ok',
    });
  });

  it('takes a node it cannot read more of as ready, so a proxy that serves health alone is not turned away', async () => {
    expect(await node({ health: Response.json({ status: 'ok' }) }).probe()).toMatchObject({ kind: 'ok' });
    expect(
      await node({ health: health('not a version'), readiness: new TypeError('Failed to fetch') }).probe(),
    ).toMatchObject({ kind: 'ok' });
    expect(
      await node({ health: health('2.8.2'), readiness: READY, peers: new Response('{', { status: 200 }) }).probe(),
    ).toMatchObject({ kind: 'ok' });
  });

  it('holds the floor at the release that added GET /soc, which feed entries and markers are read through', () => {
    expect(MINIMUM_BEE_VERSION).toBe('2.3.0');
  });
});

/**
 * A browser reports a closed port and a node that refuses this site's origin the same way, as a fetch
 * that rejects. A second request with `mode: 'no-cors'` tells them apart: the browser hands such a
 * request an opaque answer whatever the node's CORS settings, and rejects it only when nothing answered.
 */
describe('telling nothing at an address apart from a node that refuses this site', () => {
  const refused = new TypeError('Failed to fetch');

  it('asks the health path again without CORS when nothing readable came back', async () => {
    const { asked, probe } = node({ health: refused, readiness: refused, peers: refused });
    await probe();

    expect(asked.filter(({ mode }) => mode === 'no-cors')).toEqual([
      { url: 'http://localhost:1633/health', mode: 'no-cors' },
    ]);
  });

  it('finds a node that answers and refuses this site when the second request is answered', async () => {
    expect(await node({ health: refused }, 'answers').probe()).toEqual({ kind: 'refuses-this-site' });
  });

  it('finds nothing at the address when the second request fails too', async () => {
    expect(await node({ health: refused }, 'refuses').probe()).toEqual({ kind: 'unreachable' });
  });

  it('asks nothing more of a node that answered, whatever it said', async () => {
    const { asked, probe } = node({ health: new Response('', { status: 502 }) }, 'answers');

    expect(await probe()).toEqual({ kind: 'rejected', status: 502 });
    expect(asked.some(({ mode }) => mode === 'no-cors')).toBe(false);
  });
});
