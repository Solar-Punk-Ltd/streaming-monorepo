/**
 * The rendition report end to end, against the in-memory ports. Unit test —
 * no Bee, no database. `pnpm test`.
 *
 * What the uploader reads back from a report is the whole reason this service
 * exists: the merged ladder it builds its master playlist from, and the
 * `flippedToFinished` that tells it to send the one `vod`. Both used to be
 * computed from reads of the stored rungs around the fold, outside the publish
 * mutex, so two overlapping reports could answer in the wrong order and both
 * claim the flip. The tests below pin that the answer is the write: the ladder
 * as the entry carries it, judged against the entry it replaced.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  FeedStreamEntry,
  Rendition,
} from '@streaming-monorepo/web2-admin-common';

import {
  InvalidStateError,
  PublishFailedError,
  StreamNotFoundError,
} from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { PublishService } from '../../src/domain/PublishService.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  streamRow,
  TEST_OWNER,
  TEST_USER_ID,
} from './support/fakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex:
    'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** A rung as the uploader reports it: live, or final with index and length. */
function rung(
  name: string,
  height: number,
  final?: { index: number; duration: number },
): Rendition {
  return {
    name,
    width: (height * 16) / 9,
    height,
    topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...(final ?? {}),
  };
}

const LIVE_360 = rung('360p', 360);
const LIVE_720 = rung('720p', 720);
const FINAL_360 = rung('360p', 360, { index: 10, duration: 61 });
const FINAL_720 = rung('720p', 720, { index: 12, duration: 62.5 });

/** A published stream with its entry on the feed: where every report starts. */
async function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const publishService = new PublishService(
    store,
    renditions,
    new FakeFeedWriteLog(),
    gateway,
    feed,
  );
  const service = new LadderService(store, renditions, publishService);
  const stream = store.add(streamRow());
  await publishService.publish(stream.id, TEST_USER_ID);
  return { store, gateway, service, stream };
}

/** The stream's entry as the write at `index` left it on the feed. */
function entryAt(
  gateway: FakeFeedGateway,
  index: number,
  topic: string,
): FeedStreamEntry {
  const write = gateway.writes.find((w) => w.index === index);
  assert.ok(write, `a write at index ${index}`);
  const entry = (write.entries as FeedStreamEntry[]).find(
    (e) => e.topic === topic,
  );
  assert.ok(entry, `an entry for ${topic} at index ${index}`);
  return entry;
}

describe('LadderService.report', () => {
  it('refuses a stream nobody has announced', async () => {
    const { store, service } = await setup();
    const draft = store.add(streamRow());
    const publishing = store.add(streamRow({ status: 'publishing' }));

    await assert.rejects(
      () => service.report('00000000-0000-4000-8000-0000000000ff', LIVE_360),
      StreamNotFoundError,
    );
    await assert.rejects(
      () => service.report(draft.id, LIVE_360),
      (err: unknown) =>
        err instanceof InvalidStateError && err.currentStatus === 'draft',
    );
    await assert.rejects(
      () => service.report(publishing.id, LIVE_360),
      (err: unknown) =>
        err instanceof InvalidStateError && err.currentStatus === 'publishing',
    );
  });

  it('answers an unfinished ladder for the first rung, and leaves the status alone', async () => {
    const { store, gateway, service, stream } = await setup();

    const outcome = await service.report(stream.id, LIVE_360);

    assert.deepEqual(outcome.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });
    assert.deepEqual(outcome.renditions, [LIVE_360]);
    assert.equal(outcome.publish.stream.status, 'published');
    assert.equal(
      store.get(stream.id).status,
      'published',
      'a rung never moves it',
    );
    const entry = entryAt(gateway, outcome.publish.feed.index, stream.topic);
    assert.equal(entry.group, stream.topic);
    assert.deepEqual(entry.renditions, [LIVE_360]);
  });

  it('flips to finished on the last final report, with the longest rung as the duration', async () => {
    const { service, stream } = await setup();
    await service.report(stream.id, LIVE_360);
    await service.report(stream.id, LIVE_720);

    const first = await service.report(stream.id, FINAL_360);
    assert.deepEqual(first.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });

    const last = await service.report(stream.id, FINAL_720);
    assert.deepEqual(last.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 62.5,
    });
    assert.deepEqual(last.renditions, [FINAL_360, FINAL_720], 'by height');
  });

  it('does not flip again when the uploader repeats the final report', async () => {
    const { service, stream } = await setup();
    await service.report(stream.id, LIVE_360);
    await service.report(stream.id, LIVE_720);
    await service.report(stream.id, FINAL_360);
    const last = await service.report(stream.id, FINAL_720);
    assert.equal(last.ladder.flippedToFinished, true);

    const repeated = await service.report(stream.id, FINAL_720);

    assert.deepEqual(repeated.ladder, {
      finished: true,
      flippedToFinished: false,
      duration: 62.5,
    });
  });

  it('flips on the retry when the write that finished the ladder failed', async () => {
    // The rung is stored before the feed is written, so after a failed write
    // the row holds a finished ladder the catalogue does not show yet. The
    // flip is judged against the catalogue, so the retry still gets its cue.
    const { gateway, service, stream } = await setup();
    await service.report(stream.id, LIVE_360);
    await service.report(stream.id, LIVE_720);
    await service.report(stream.id, FINAL_360);
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(
      () => service.report(stream.id, FINAL_720),
      PublishFailedError,
    );

    const retried = await service.report(stream.id, FINAL_720);
    assert.equal(retried.ladder.finished, true);
    assert.equal(retried.ladder.flippedToFinished, true);
  });

  it('flips exactly once when two final reports overlap', async () => {
    // Both fold before either reaches the mutex. Judged from the stored rungs
    // around each fold, both would see a ladder unfinished before and
    // finished after, and both would claim the flip; the cue to send `vod`
    // is meant to fire once, from the report whose write finished the entry.
    const { gateway, service, stream } = await setup();
    await service.report(stream.id, LIVE_360);
    await service.report(stream.id, LIVE_720);
    const before = gateway.writes.length;

    const outcomes = await Promise.all([
      service.report(stream.id, FINAL_360),
      service.report(stream.id, FINAL_720),
    ]);

    const flipped = outcomes.filter((o) => o.ladder.flippedToFinished);
    assert.equal(flipped.length, 1);
    assert.equal(flipped[0]!.ladder.finished, true);
    assert.equal(flipped[0]!.ladder.duration, 62.5);
    assert.equal(gateway.writes.length, before + 2, 'one write per report');
    const last = entryAt(gateway, gateway.writes.at(-1)!.index, stream.topic);
    assert.deepEqual(last.renditions, [FINAL_360, FINAL_720]);
  });

  it('answers each overlapping report with the ladder its own write put on the feed', async () => {
    // The uploader writes its master playlist from the ladder it is handed, so
    // an answer describing an older entry than the one this report wrote
    // would put an older master over a newer one. Each answer is the ladder
    // of the entry at the feed index it reports, and the later write carries
    // both rungs.
    const { gateway, service, stream } = await setup();

    const outcomes = await Promise.all([
      service.report(stream.id, LIVE_360),
      service.report(stream.id, LIVE_720),
    ]);

    for (const outcome of outcomes) {
      const entry = entryAt(gateway, outcome.publish.feed.index, stream.topic);
      assert.deepEqual(outcome.renditions, entry.renditions);
    }
    const [, later] = [...outcomes].sort(
      (a, b) => a.publish.feed.index - b.publish.feed.index,
    );
    assert.deepEqual(
      later!.renditions.map((r) => r.name),
      ['360p', '720p'],
    );
  });
});
