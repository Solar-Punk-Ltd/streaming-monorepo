import { Topic } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import { GatewayClock } from '../../src/utils/gatewayClock';
import { SwarmClient, type SwarmClientOptions } from '../../src/swarm/client';
import { DEFAULT_READ_TIMEOUT_MS } from '../../src/swarm/provider';
import { BeeHttpProvider } from '../../src/swarm/providers/bee-http/beeHttpProvider';
import { answeringFetch } from '../helpers/fakeBeeGateway';
import { content, fault, notFound, ScriptedProvider } from '../helpers/scriptedProvider';

const OWNER = '1'.repeat(40);
const TOPIC = Topic.fromString('client-test');
const REFERENCE = 'ef'.repeat(32);

const POLICY = { faultsBeforePause: 2, firstPauseMs: 1_000, longestPauseMs: 3_000 };

interface World {
  readonly chosen: ScriptedProvider;
  readonly fallback: ScriptedProvider;
  readonly client: SwarmClient;
  /** Moves the client's clock on. */
  advance(ms: number): void;
}

function world(options: Partial<SwarmClientOptions> = {}): World {
  const chosen = new ScriptedProvider('chosen');
  const fallback = new ScriptedProvider('fallback');
  let nowMs = 0;
  const client = new SwarmClient({
    chosen: { id: 'chosen', provider: chosen },
    fallback: { id: 'fallback', provider: fallback },
    pausePolicy: POLICY,
    now: () => nowMs,
    ...options,
  });
  return {
    chosen,
    fallback,
    client,
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

const readBytes = (client: SwarmClient) => client.reader('player').readBytes(REFERENCE);

describe('the Swarm client', () => {
  it("answers a feature's read from the chosen provider, as that provider answered it", async () => {
    const { chosen, fallback, client } = world();
    chosen.answer = content();

    expect(await client.reader('stream-list').readFeedHead(OWNER, TOPIC)).toBe(chosen.answer);
    expect(await client.reader('player').readFeedEntry(OWNER, TOPIC, 4)).toBe(chosen.answer);
    expect(await client.reader('player').readSoc(OWNER, REFERENCE)).toBe(chosen.answer);
    expect(await client.reader('previews').readChunk(REFERENCE)).toBe(chosen.answer);
    expect(await client.reader('previews').readBytes(REFERENCE)).toBe(chosen.answer);
    expect(chosen.asked).toEqual(['feed-head', 'feed-entry', 'soc', 'chunk', 'bytes']);
    expect(fallback.asked).toEqual([]);
  });

  describe('falling back', () => {
    it('asks the fallback when the chosen provider is unavailable, and answers with its answer', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = fault;
      fallback.answer = content();

      expect(await readBytes(client)).toBe(fallback.answer);
      expect(chosen.asked).toEqual(['bytes']);
      expect(fallback.asked).toEqual(['bytes']);
    });

    it('asks the fallback when the chosen provider cannot make that read at all', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = { kind: 'unsupported' };
      fallback.answer = content();

      expect(await readBytes(client)).toBe(fallback.answer);
    });

    it('takes not found as the answer, because it is one about the content, not a fault', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = notFound;

      expect(await readBytes(client)).toBe(notFound);
      expect(fallback.asked).toEqual([]);
    });

    it('asks nobody else once the caller has stopped the read', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = { kind: 'aborted' };

      expect(await readBytes(client)).toEqual({ kind: 'aborted' });
      expect(fallback.asked).toEqual([]);
    });

    it('answers the last fault when the fallback fails too', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = fault;
      fallback.answer = { kind: 'unavailable', cause: { kind: 'status', status: 502 } };

      expect(await readBytes(client)).toBe(fallback.answer);
    });

    it('has nobody to fall back to when the fallback is the chosen provider', async () => {
      const chosen = new ScriptedProvider('chosen');
      chosen.answer = fault;
      const client = new SwarmClient({
        chosen: { id: 'event', provider: chosen },
        fallback: { id: 'event', provider: chosen },
      });

      expect(await readBytes(client)).toBe(fault);
      expect(chosen.asked).toEqual(['bytes']);
    });

    it('takes a chunk Bee answers 500 for as not there, so the fallback is not asked', async () => {
      const bee = new BeeHttpProvider({ baseUrl: 'http://bee.example', fetcher: answeringFetch(500) });
      const fallback = new ScriptedProvider('fallback');
      const client = new SwarmClient({
        chosen: { id: 'event', provider: bee },
        fallback: { id: 'fallback', provider: fallback },
        pausePolicy: { ...POLICY, faultsBeforePause: 1 },
      });

      expect(await client.reader('player').readChunk(REFERENCE)).toMatchObject({ kind: 'not-found' });
      expect(fallback.asked).toEqual([]);
      expect(client.health()).toContainEqual({ id: 'event', faultsInARow: 0, pausedUntilMs: null });
    });
  });

  describe("keeping a read inside the caller's window", () => {
    const WINDOW_MS = 1_000;
    const readInWindow = (client: SwarmClient) =>
      client.reader('player').readBytes(REFERENCE, { timeoutMs: WINDOW_MS });

    it('gives the fallback only what is left of the window after the chosen provider hung', async () => {
      const { chosen, fallback, client, advance } = world();
      chosen.answer = { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: WINDOW_MS } };
      chosen.onAsk = () => advance(600);
      fallback.answer = content();

      expect(await readInWindow(client)).toBe(fallback.answer);
      expect(chosen.windows).toEqual([WINDOW_MS]);
      expect(fallback.windows).toEqual([400]);
    });

    it('does not ask the fallback once the chosen provider used the whole window', async () => {
      const { chosen, fallback, client, advance } = world();
      chosen.answer = { kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: WINDOW_MS } };
      chosen.onAsk = () => advance(WINDOW_MS);

      expect(await readInWindow(client)).toBe(chosen.answer);
      expect(fallback.asked).toEqual([]);
    });

    it('takes the default window as the whole budget when the caller names none', async () => {
      const { chosen, fallback, client, advance } = world();
      chosen.answer = fault;
      chosen.onAsk = () => advance(DEFAULT_READ_TIMEOUT_MS - 250);

      await readBytes(client);

      expect(chosen.windows).toEqual([DEFAULT_READ_TIMEOUT_MS]);
      expect(fallback.windows).toEqual([250]);
    });
  });

  describe('pausing a provider that keeps failing', () => {
    it('leaves the chosen provider alone after faults in a row, then tries it again', async () => {
      const { chosen, fallback, client, advance } = world();
      chosen.answer = fault;
      fallback.answer = content();

      await readBytes(client);
      await readBytes(client);
      expect(chosen.asked).toHaveLength(2);

      await readBytes(client);
      expect(chosen.asked).toHaveLength(2);
      expect(client.health()).toContainEqual({ id: 'chosen', faultsInARow: 2, pausedUntilMs: POLICY.firstPauseMs });

      advance(POLICY.firstPauseMs);
      chosen.answer = content();
      expect(await readBytes(client)).toBe(chosen.answer);
      expect(chosen.asked).toHaveLength(3);
      expect(client.health()).toContainEqual({ id: 'chosen', faultsInARow: 0, pausedUntilMs: null });
    });

    it('pauses again at once, for longer, when the first read after a pause fails, up to the longest pause', async () => {
      const { chosen, client, advance } = world();
      chosen.answer = fault;

      await readBytes(client);
      await readBytes(client);
      advance(POLICY.firstPauseMs);
      await readBytes(client);
      expect(client.health()).toContainEqual({
        id: 'chosen',
        faultsInARow: 3,
        pausedUntilMs: POLICY.firstPauseMs + 2 * POLICY.firstPauseMs,
      });

      advance(2 * POLICY.firstPauseMs);
      await readBytes(client);
      expect(client.health()).toContainEqual({
        id: 'chosen',
        faultsInARow: 4,
        pausedUntilMs: 3 * POLICY.firstPauseMs + POLICY.longestPauseMs,
      });
    });

    it('does not count a not found as a fault', async () => {
      const { chosen, client } = world();
      chosen.answer = fault;
      await readBytes(client);
      chosen.answer = notFound;
      await readBytes(client);
      chosen.answer = fault;
      await readBytes(client);

      expect(client.health()).toContainEqual({ id: 'chosen', faultsInARow: 1, pausedUntilMs: null });
    });

    it('leaves a rate-limited provider alone for as long as it asked, without counting a fault', async () => {
      const { chosen, fallback, client, advance } = world();
      chosen.answer = { kind: 'rate-limited', retryAfterMs: 5_000, serverTimeMs: null };
      fallback.answer = content();

      expect(await readBytes(client)).toBe(fallback.answer);
      expect(client.health()).toContainEqual({ id: 'chosen', faultsInARow: 0, pausedUntilMs: 5_000 });

      advance(4_999);
      await readBytes(client);
      expect(chosen.asked).toHaveLength(1);

      advance(1);
      await readBytes(client);
      expect(chosen.asked).toHaveLength(2);
    });

    it('waits the first pause for a rate limit that named no wait', async () => {
      const { chosen, client } = world();
      chosen.answer = { kind: 'rate-limited', retryAfterMs: null, serverTimeMs: null };

      await readBytes(client);

      expect(client.health()).toContainEqual({ id: 'chosen', faultsInARow: 0, pausedUntilMs: POLICY.firstPauseMs });
    });

    it('still asks a paused provider when every provider is paused, so reads never stop', async () => {
      const { chosen, fallback, client } = world();
      chosen.answer = fault;
      fallback.answer = fault;
      for (let read = 0; read < POLICY.faultsBeforePause; read += 1) {
        await readBytes(client);
      }
      chosen.answer = content();

      expect(await readBytes(client)).toBe(chosen.answer);
    });
  });

  it('routes a feature to the provider it is given, with the same fallback', async () => {
    const previewGateway = new ScriptedProvider('previews');
    const { chosen, fallback, client } = world({ routes: { previews: { id: 'previews', provider: previewGateway } } });
    previewGateway.answer = fault;
    fallback.answer = content();

    await client.reader('previews').readChunk(REFERENCE);
    await client.reader('player').readChunk(REFERENCE);

    expect(previewGateway.asked).toEqual(['chunk']);
    expect(fallback.asked).toEqual(['chunk']);
    expect(chosen.asked).toEqual(['chunk']);
  });

  it('counts every read by feature, kind of read, provider and answer', async () => {
    const { chosen, fallback, client } = world();
    chosen.answer = content();
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 1);
    await client.reader('player').readFeedEntry(OWNER, TOPIC, 2);
    chosen.answer = fault;
    fallback.answer = notFound;
    await client.reader('stream-list').readFeedHead(OWNER, TOPIC);

    expect(client.counts()).toEqual(
      expect.arrayContaining([
        { feature: 'player', read: 'feed-entry', provider: 'chosen', answer: 'content', count: 2 },
        { feature: 'stream-list', read: 'feed-head', provider: 'chosen', answer: 'unavailable', count: 1 },
        { feature: 'stream-list', read: 'feed-head', provider: 'fallback', answer: 'not-found', count: 1 },
      ]),
    );
    expect(client.counts()).toHaveLength(3);
  });

  describe('the gateway clock', () => {
    it('learns the offset from the server time of any answer, whichever feature read it', async () => {
      const gatewayMs = Date.UTC(2026, 9, 7, 12, 0, 30);
      const clock = new GatewayClock(() => gatewayMs - 60_000);
      const { chosen, client } = world({ clock });
      chosen.answer = { kind: 'not-found', serverTimeMs: gatewayMs };

      await client.reader('player').readFeedEntry(OWNER, TOPIC, 9);

      expect(client.clockOffsetMs()).toBe(60_500);
    });

    it('keeps the offset it had when an answer carries no server time', async () => {
      const gatewayMs = Date.UTC(2026, 9, 7, 12, 0, 30);
      const clock = new GatewayClock(() => gatewayMs + 2_000);
      const { chosen, client } = world({ clock });
      chosen.answer = content(gatewayMs);
      await readBytes(client);
      chosen.answer = content(null);
      await readBytes(client);

      expect(client.clockOffsetMs()).toBe(-1_500);
    });
  });

  describe('URLs the browser loads itself', () => {
    it("come from the feature's provider while it is not paused", async () => {
      const { chosen, client } = world();

      expect(client.reader('player').urlFor(REFERENCE, 'segment')).toBe(`chosen:segment:${REFERENCE}`);

      chosen.answer = fault;
      for (let read = 0; read < POLICY.faultsBeforePause; read += 1) {
        await readBytes(client);
      }
      expect(client.reader('player').urlFor(REFERENCE, 'segment')).toBe(`fallback:segment:${REFERENCE}`);
    });

    it('come from the fallback when the chosen provider gives none, and are null when nobody does', () => {
      const { chosen, fallback, client } = world();
      chosen.capabilities = { ...chosen.capabilities, urls: false };

      expect(client.reader('previews').urlFor(REFERENCE, 'thumbnail')).toBe(`fallback:thumbnail:${REFERENCE}`);

      fallback.capabilities = { ...fallback.capabilities, urls: false };
      expect(client.reader('previews').urlFor(REFERENCE, 'thumbnail')).toBeNull();
    });
  });

  it('starts and stops every provider it holds, once each', async () => {
    const previewGateway = new ScriptedProvider('previews');
    const { chosen, fallback, client } = world({ routes: { previews: { id: 'previews', provider: previewGateway } } });

    await client.start();
    await client.stop();

    for (const provider of [chosen, fallback, previewGateway]) {
      expect([provider.started, provider.stopped]).toEqual([1, 1]);
    }
  });
});
