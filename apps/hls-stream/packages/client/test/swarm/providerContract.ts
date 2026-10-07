import type { Topic } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import type { SwarmAnswer } from '../../src/swarm/answers';
import type { SwarmProvider } from '../../src/swarm/provider';

/** What a provider under contract holds, so each case can name content it knows is there or is not. */
interface ContractWorld {
  readonly feedHead: {
    readonly owner: string;
    readonly topic: Topic;
    readonly index: number;
    readonly bytes: Uint8Array;
    readonly serverTimeMs: number;
  };
  readonly feedEntry: {
    readonly owner: string;
    readonly topic: Topic;
    readonly index: number;
    readonly bytes: Uint8Array;
  };
  readonly soc: { readonly owner: string; readonly identifier: string; readonly bytes: Uint8Array };
  readonly chunk: { readonly address: string; readonly bytes: Uint8Array };
  readonly bytes: { readonly reference: string; readonly bytes: Uint8Array };
  /** Names for which nothing is stored. */
  readonly absent: {
    readonly owner: string;
    readonly topic: Topic;
    readonly index: number;
    readonly identifier: string;
    readonly address: string;
    readonly reference: string;
  };
}

/**
 * How the provider's far side behaves for one case. `served` answers from the world, `silent` accepts
 * a read and never answers, `faulty` fails every read, and `rate-limited` asks for every read to wait.
 */
type ContractBehaviour = 'served' | 'silent' | 'faulty' | 'rate-limited';

export interface ContractHarness {
  readonly world: ContractWorld;
  /** What the `rate-limited` far side asks for. */
  readonly retryAfterMs: number;
  provider(behaviour: ContractBehaviour): SwarmProvider;
}

/** A window short enough that a case waiting it out costs the suite nothing. */
const SHORT_WINDOW_MS = 40;

type Read = (provider: SwarmProvider, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<SwarmAnswer>;

function readsOf(world: ContractWorld): Record<string, Read> {
  return {
    'a feed head': (provider, options) => provider.readFeedHead(world.feedHead.owner, world.feedHead.topic, options),
    'a feed entry': (provider, options) =>
      provider.readFeedEntry(world.feedEntry.owner, world.feedEntry.topic, world.feedEntry.index, options),
    'a single-owner chunk': (provider, options) => provider.readSoc(world.soc.owner, world.soc.identifier, options),
    'a chunk': (provider, options) => provider.readChunk(world.chunk.address, options),
    bytes: (provider, options) => provider.readBytes(world.bytes.reference, options),
  };
}

function absentReadsOf(world: ContractWorld): Record<string, Read> {
  const { absent } = world;
  return {
    'a feed head': (provider) => provider.readFeedHead(absent.owner, absent.topic),
    'a feed entry': (provider) => provider.readFeedEntry(absent.owner, absent.topic, absent.index),
    'a single-owner chunk': (provider) => provider.readSoc(absent.owner, absent.identifier),
    'a chunk': (provider) => provider.readChunk(absent.address),
    bytes: (provider) => provider.readBytes(absent.reference),
  };
}

function contentOf(answer: SwarmAnswer) {
  if (answer.kind !== 'content') {
    throw new Error(`expected content, the provider answered ${JSON.stringify(answer)}`);
  }
  return answer;
}

/**
 * The cases every provider must pass, whatever it reaches Swarm through. A provider kind runs this
 * once with a harness of its own, against answers recorded or built for it, never against a network.
 */
export function describeProviderContract(name: string, harness: () => ContractHarness): void {
  describe(`the provider contract: ${name}`, () => {
    it('reads a feed head with its index and the server time', async () => {
      const { world, provider } = harness();
      const answer = contentOf(await provider('served').readFeedHead(world.feedHead.owner, world.feedHead.topic));

      expect(answer.bytes).toEqual(world.feedHead.bytes);
      expect(answer.feedIndex).toBe(world.feedHead.index);
      expect(answer.serverTimeMs).toBe(world.feedHead.serverTimeMs);
    });

    it('reads a feed entry by its index', async () => {
      const { world, provider } = harness();
      const { owner, topic, index } = world.feedEntry;
      const answer = contentOf(await provider('served').readFeedEntry(owner, topic, index));

      expect(answer.bytes).toEqual(world.feedEntry.bytes);
    });

    it("reads a single-owner chunk's payload by its owner and identifier", async () => {
      const { world, provider } = harness();
      const answer = contentOf(await provider('served').readSoc(world.soc.owner, world.soc.identifier));

      expect(answer.bytes).toEqual(world.soc.bytes);
    });

    it('reads a chunk by its address', async () => {
      const { world, provider } = harness();
      const answer = contentOf(await provider('served').readChunk(world.chunk.address));

      expect(answer.bytes).toEqual(world.chunk.bytes);
    });

    it('reads the bytes a reference names', async () => {
      const { world, provider } = harness();
      const answer = contentOf(await provider('served').readBytes(world.bytes.reference));

      expect(answer.bytes).toEqual(world.bytes.bytes);
    });

    for (const [what, read] of Object.entries(absentReadsOf(harness().world))) {
      it(`answers not found for ${what} that is not there`, async () => {
        const answer = await read(harness().provider('served'));

        expect(answer.kind).toBe('not-found');
      });
    }

    for (const [what, read] of Object.entries(readsOf(harness().world))) {
      it(`answers aborted when the caller stops a read of ${what} in flight`, async () => {
        const controller = new AbortController();
        const pending = read(harness().provider('silent'), { signal: controller.signal });
        controller.abort();

        expect(await pending).toEqual({ kind: 'aborted' });
      });

      it(`answers aborted without asking when the caller stopped a read of ${what} before it began`, async () => {
        const controller = new AbortController();
        controller.abort();

        expect(await read(harness().provider('faulty'), { signal: controller.signal })).toEqual({ kind: 'aborted' });
      });

      it(`answers unavailable with a timeout when nothing comes back for ${what}`, async () => {
        const answer = await read(harness().provider('silent'), { timeoutMs: SHORT_WINDOW_MS });

        expect(answer).toEqual({ kind: 'unavailable', cause: { kind: 'timeout', timeoutMs: SHORT_WINDOW_MS } });
      });

      it(`answers unavailable, never throws, when reading ${what} fails`, async () => {
        const answer = await read(harness().provider('faulty'));

        expect(answer.kind).toBe('unavailable');
      });

      it(`answers rate limited with the wait asked for when reading ${what}`, async () => {
        const answer = await read(harness().provider('rate-limited'));

        expect(answer).toMatchObject({ kind: 'rate-limited', retryAfterMs: harness().retryAfterMs });
      });
    }
  });
}
