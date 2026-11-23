/**
 * A ladder published against an admin that writes no catalog entry, and answers each rung report with an order
 * number of its own in the place of a catalog write index.
 *
 * The admin's answer to a rung report carries `feed.index`, which the uploader reads as a number and compares, and
 * nothing more: `AdminLadderRegistry.adopt` skips an answer whose number is lower than one already taken. An admin
 * that writes no catalog for a stream can count its merges instead. This drives the registry, the admin client and
 * the master writer over such an admin and a fake Bee:
 *
 * 1. every feed this service writes is the ladder's master, on the declared topic, so nothing else is published;
 * 2. four rungs reporting at once, answered in an order other than the admin merged them, leave a master that names
 *    every rung, and no master written after the newest merge landed misses one;
 * 3. the final reports, answered out of order, leave the recording's master naming every recorded rung, and hand
 *    out the flip to `vod` once, naming that master.
 *
 * The fake admin answers `feed` with the order number alone: no owner, topic or entry count, since no catalog feed
 * exists for such a stream.
 */

import { BeeResponseError, FeedIndex, PrivateKey, Topic } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminApiClient } from '../src/libs/AdminApiClient.js';
import { AdminLadderRegistry } from '../src/libs/AdminLadderRegistry.js';
import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { LadderIdentity, RenditionAnnouncement } from '../src/libs/LadderRegistry.js';
import { MasterFeedWriter } from '../src/libs/MasterFeedWriter.js';
import { buildSwarmUri } from '../src/libs/MasterPlaylist.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

import { waitFor } from './helpers/waiting.js';

const TEST_KEY = '0'.repeat(63) + '7';
const ADMIN_URL = 'http://admin.test:9877';
const ADMIN_STREAM_ID = 'str_test_stream';
const DECLARED_TOPIC = 'test-stream-topic-0001';
const SETTLE_CEILING_MS = 4_000;

const IDENTITY: LadderIdentity = {
  title: 'A test broadcast',
  owner: '0xowner',
  group: DECLARED_TOPIC,
  mediatype: MEDIA_TYPE_VIDEO,
  adminStreamId: ADMIN_STREAM_ID,
};

const HEIGHTS = [360, 480, 720, 1080] as const;

const rung = (height: number, final?: { index: number; duration: number }): Rendition => ({
  name: `${height}p`,
  width: Math.round((height * 16) / 9),
  height,
  topic: `topic-${height}p`,
  bandwidth: height * 2_000,
  avgBandwidth: height * 1_800,
  ...(final ?? {}),
});

/** One rung report the fake admin has merged and not yet answered. */
interface HeldAnswer {
  rung: string;
  order: number;
  release: () => void;
}

/**
 * An admin that holds a test stream: it merges each rung's record into the ladder it holds, as the real admin's
 * merge does (a rung that finished keeps its index when it reports again without one), counts each merge, and
 * answers with the ladder and the count in `feed.index`. It holds no catalog and writes none.
 *
 * Every answer is held until the case releases it, so a case decides the order answers land in. The merge and the
 * count happen as the report arrives, the order the real admin's lock gives them.
 */
class OrderNumberAdmin {
  private readonly ladder = new Map<string, Rendition>();
  private order = 0;
  private finishedBefore = false;
  readonly held: HeldAnswer[] = [];
  readonly posted: string[] = [];

  readonly fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    this.posted.push(String(input));
    const reported = JSON.parse(String(init?.body)) as Rendition;
    const body = this.merge(reported);
    const order = this.order;
    await new Promise<void>((release) => this.held.push({ rung: reported.name, order, release }));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;

  private merge(reported: Rendition): unknown {
    const before = this.ladder.get(reported.name);
    const keepsFinish = reported.index === undefined && before?.index !== undefined;
    this.ladder.set(
      reported.name,
      keepsFinish ? { ...reported, index: before.index, duration: before.duration } : reported,
    );
    this.order += 1;

    const renditions = [...this.ladder.values()].sort((a, b) => a.height - b.height);
    const finished = renditions.length > 0 && renditions.every((r) => r.index !== undefined);
    const flippedToFinished = finished && !this.finishedBefore;
    this.finishedBefore = finished;
    const duration = finished ? Math.max(...renditions.map((r) => r.duration ?? 0)) : null;
    return {
      stream: { id: ADMIN_STREAM_ID, status: 'live' },
      renditions,
      ladder: { finished, flippedToFinished, duration },
      // The admin's own order number, and nothing of a catalog feed.
      feed: { index: this.order },
    };
  }

  /** Releases held answers by merge number, in this order, each landing before the next is released. */
  async releaseInOrder(orders: readonly number[], settled: (rung: string) => Promise<unknown>): Promise<void> {
    for (const order of orders) {
      const answer = this.held.find((held) => held.order === order);
      assert.ok(answer, `an answer numbered ${order} is held`);
      answer.release();
      await settled(answer.rung);
    }
  }
}

/** One feed write the fake Bee took. */
interface FeedWrite {
  topicHex: string;
  index: bigint;
  payload: string;
}

/** A Bee that keeps every feed write, so a master's head is the last one written to its topic. */
function fakeBee(writes: FeedWrite[]) {
  return {
    feed: {
      makeReader: (topic: Topic) => ({
        downloadPayload: async () => {
          const head = writes.filter((write) => write.topicHex === topic.toString()).at(-1);
          if (!head) throw new BeeResponseError('GET', '/feeds', 'Not Found.', undefined, 404, 'Not Found');
          return { feedIndex: FeedIndex.fromBigInt(head.index), payload: { toUtf8: () => head.payload } };
        },
      }),
      makeWriter: (topic: Topic) => ({
        uploadPayload: async (_stamp: string, payload: unknown, opts: { index: FeedIndex }) => {
          writes.push({ topicHex: topic.toString(), index: opts.index.toBigInt(), payload: String(payload) });
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
  };
}

interface Harness {
  admin: OrderNumberAdmin;
  registry: AdminLadderRegistry;
  writes: FeedWrite[];
  owner: string;
}

function harness(): Harness {
  const admin = new OrderNumberAdmin();
  const writes: FeedWrite[] = [];
  const publisher = { rung: 'coordinator', url: '', stamp: 'stamp', bee: fakeBee(writes) };
  const publishers = { coordinator: () => publisher } as unknown as BeePublisherPool;
  const masterWriter = new MasterFeedWriter(publishers, new PrivateKey(TEST_KEY));
  const registry = new AdminLadderRegistry({
    client: new AdminApiClient({
      baseUrl: ADMIN_URL,
      token: 'admin-api-token-0123456789abcdef',
      fetcher: admin.fetcher,
      sleep: async () => {},
    }),
    masterWriter,
    now: () => 0,
  });
  return { admin, registry, writes, owner: masterWriter.owner };
}

/** The master playlist of these rungs, line by line, as a player reads it. */
function expectedMaster(owner: string, rungs: readonly Rendition[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const r of rungs) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.avgBandwidth},RESOLUTION=${r.width}x${r.height}`,
    );
    lines.push(buildSwarmUri(owner, r.topic));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reports these rungs at once, waits until the admin has merged all of them, then releases their answers in the
 * given order of merge numbers, counted from this call's first, each answer landing before the next.
 */
async function reportAtOnce(
  h: Harness,
  rungs: readonly Rendition[],
  answerOrder: readonly number[],
): Promise<Map<string, RenditionAnnouncement>> {
  const mergedBefore = h.admin.held.length;
  const pending = new Map(rungs.map((r) => [r.name, h.registry.upsertRendition(IDENTITY, r)] as const));
  await waitFor(() => h.admin.held.length === mergedBefore + rungs.length, SETTLE_CEILING_MS);
  await h.admin.releaseInOrder(
    answerOrder.map((n) => mergedBefore + n),
    (name) => pending.get(name)!,
  );
  const announced = new Map<string, RenditionAnnouncement>();
  for (const [name, work] of pending) announced.set(name, await work);
  return announced;
}

/** Every feed write landed on the ladder's master, the declared topic, and the admin heard rung reports alone. */
function assertOnlyMasters(h: Harness): void {
  const master = Topic.fromString(DECLARED_TOPIC).toString();
  assert.ok(h.writes.length > 0, 'a master was written');
  for (const write of h.writes) assert.equal(write.topicHex, master, 'every feed write is the master');
  for (const url of h.admin.posted) {
    assert.equal(url, `${ADMIN_URL}/api/internal/streams/${ADMIN_STREAM_ID}/renditions`, 'only rung reports');
  }
}

describe('a ladder against an admin that answers with an order number and writes no catalog', () => {
  const live = HEIGHTS.map((height) => rung(height));

  // The admin merged 360p, 480p, 720p and 1080p in that order (numbers 1 to 4); the answers land in other orders.
  for (const answerOrder of [
    [4, 3, 2, 1],
    [2, 4, 1, 3],
    [3, 1, 4, 2],
  ]) {
    it(`publishes a master naming every rung when four reports are answered in the order ${answerOrder.join(', ')}`, async () => {
      const h = harness();

      await reportAtOnce(h, live, answerOrder);

      assertOnlyMasters(h);
      const full = expectedMaster(h.owner, live);
      assert.equal(h.writes.at(-1)!.payload, full, 'the master at the head names every rung, ascending');
      // Once the merge naming all four has landed, no later master drops a rung: an older answer is skipped.
      const firstFull = h.writes.findIndex((write) => write.payload === full);
      assert.ok(firstFull >= 0);
      for (const write of h.writes.slice(firstFull)) assert.equal(write.payload, full);
      // Each master went to the next index of its feed.
      assert.deepEqual(
        h.writes.map((write) => write.index),
        h.writes.map((_, i) => BigInt(i)),
      );
    });
  }

  it('writes no master missing a rung when the newest merge lands first and every older one trails in', async () => {
    const h = harness();

    await reportAtOnce(h, live, [4, 3, 2, 1]);

    const full = expectedMaster(h.owner, live);
    assert.ok(
      h.writes.every((write) => write.payload === full),
      'every master names all four rungs',
    );
  });

  it('ends the broadcast with a recording master naming every recorded rung, and hands out the flip once', async () => {
    const h = harness();
    await reportAtOnce(h, live, [1, 2, 3, 4]);

    const final = HEIGHTS.map((height, i) => rung(height, { index: 40 + i, duration: 120 + i }));
    // The final reports are merged as numbers 5 to 8; the answer of the merge that finished the ladder lands second.
    const announced = await reportAtOnce(h, final, [2, 4, 1, 3]);

    assertOnlyMasters(h);
    const recording = expectedMaster(h.owner, final);
    assert.equal(h.writes.at(-1)!.payload, recording, 'the recording names every rung');
    const flips = [...announced.values()].filter((a) => a.flippedToFinished);
    assert.equal(flips.length, 1, 'one rung reports the recording to the admin');
    assert.equal(flips[0]!.duration, 123, 'the recording plays for the longest rung');
    const named = flips[0]!.masterIndex;
    assert.notEqual(named, null);
    assert.equal(
      h.writes.find((write) => write.index === BigInt(named!))?.payload,
      recording,
      'the flip names a master that holds the recording',
    );
  });
});
