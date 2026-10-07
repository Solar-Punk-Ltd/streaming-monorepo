/**
 * The rendition report end to end, against the in-memory ports. Unit test —
 * no Bee, no database. `pnpm test`.
 *
 * What the uploader reads back from a report is the whole reason this service
 * exists: the merged ladder it builds its master playlist from, and the
 * `flippedToFinished` that tells it to send the one `vod`. Both used to be
 * computed from reads of the stored rungs around the merge, outside the publish
 * mutex, so two overlapping reports could answer in the wrong order and both
 * claim the flip. The tests below pin that the answer is the write: the ladder
 * as the entry carries it, judged against the entry it replaced.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedStreamEntry, Rendition } from '@streaming-monorepo/web2-admin-common';

import { InvalidStateError, PublishFailedError, StreamNotFoundError } from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';

import {
  FakeFeedWriteLog,
  FakeRenditionStore,
  FakeStreamStore,
  InMemoryAuditLog,
  noCatalogueStamp,
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';
import { ON_STAGE, stagesWithMain } from './support/stageFakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/** A rung as the uploader reports it: live, or final with its recording and length. */
function rung(name: string, height: number, final?: { recording: string; duration: number }): Rendition {
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

const RECORDING_360 = 'a1'.repeat(32);
const RECORDING_720 = 'b2'.repeat(32);
const RECORDING_MASTER = 'c3'.repeat(32);

const LIVE_360 = rung('360p', 360);
const LIVE_720 = rung('720p', 720);
const FINAL_360 = rung('360p', 360, { recording: RECORDING_360, duration: 61 });
const FINAL_720 = rung('720p', 720, { recording: RECORDING_720, duration: 62.5 });

/** A published stream with its entry on the feed: where every report starts. */
async function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const audit = new InMemoryAuditLog();
  const publishService = new PublishService(
    store,
    renditions,
    stagesWithMain(),
    new FakeFeedWriteLog(),
    gateway,
    noCatalogueStamp(),
    feed,
    audit,
  );
  const service = new LadderService(store, renditions, publishService, audit);
  const state = new StreamStateService(store, publishService, audit);
  const stream = store.add(streamRow());
  await publishService.publish(TEST_OPERATOR, stream.id);
  return { store, renditions, gateway, audit, service, state, stream };
}

/** The stream's entry as the write at `index` left it on the feed. */
function entryAt(gateway: FakeFeedGateway, index: number, topic: string): FeedStreamEntry {
  const write = gateway.writes.find((w) => w.index === index);
  assert.ok(write, `a write at index ${index}`);
  const entry = (write.entries as FeedStreamEntry[]).find((e) => e.topic === topic);
  assert.ok(entry, `an entry for ${topic} at index ${index}`);
  return entry;
}

describe('LadderService.report', () => {
  it('refuses a stream nobody has announced', async () => {
    const { store, service } = await setup();
    const draft = store.add(streamRow());
    const publishing = store.add(streamRow({ status: 'publishing' }));

    await assert.rejects(
      () => service.report('00000000-0000-4000-8000-0000000000ff', LIVE_360, ON_STAGE),
      StreamNotFoundError,
    );
    await assert.rejects(
      () => service.report(draft.id, LIVE_360, ON_STAGE),
      (err: unknown) => err instanceof InvalidStateError && err.currentStatus === 'draft',
    );
    await assert.rejects(
      () => service.report(publishing.id, LIVE_360, ON_STAGE),
      (err: unknown) => err instanceof InvalidStateError && err.currentStatus === 'publishing',
    );
  });

  it('answers an unfinished ladder for the first rung, and leaves the status alone', async () => {
    const { store, gateway, service, stream } = await setup();

    const outcome = await service.report(stream.id, LIVE_360, ON_STAGE);

    assert.deepEqual(outcome.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });
    assert.deepEqual(outcome.renditions, [LIVE_360]);
    assert.equal(outcome.publish.stream.status, 'published');
    assert.equal(store.get(stream.id).status, 'published', 'a rung never moves it');
    const entry = entryAt(gateway, outcome.publish.feed.index, stream.topic);
    assert.equal(entry.group, stream.topic);
    assert.deepEqual(entry.renditions, [LIVE_360]);
  });

  it('flips to finished on the last final report, with the longest rung as the duration', async () => {
    const { service, stream } = await setup();
    await service.report(stream.id, LIVE_360, ON_STAGE);
    await service.report(stream.id, LIVE_720, ON_STAGE);

    const first = await service.report(stream.id, FINAL_360, ON_STAGE);
    assert.deepEqual(first.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });

    const last = await service.report(stream.id, FINAL_720, ON_STAGE);
    assert.deepEqual(last.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 62.5,
    });
    assert.deepEqual(last.renditions, [FINAL_360, FINAL_720], 'by height');
  });

  it('does not flip again when the uploader repeats the final report', async () => {
    const { service, stream } = await setup();
    await service.report(stream.id, LIVE_360, ON_STAGE);
    await service.report(stream.id, LIVE_720, ON_STAGE);
    await service.report(stream.id, FINAL_360, ON_STAGE);
    const last = await service.report(stream.id, FINAL_720, ON_STAGE);
    assert.equal(last.ladder.flippedToFinished, true);

    const repeated = await service.report(stream.id, FINAL_720, ON_STAGE);

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
    await service.report(stream.id, LIVE_360, ON_STAGE);
    await service.report(stream.id, LIVE_720, ON_STAGE);
    await service.report(stream.id, FINAL_360, ON_STAGE);
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.report(stream.id, FINAL_720, ON_STAGE), PublishFailedError);

    const retried = await service.report(stream.id, FINAL_720, ON_STAGE);
    assert.equal(retried.ladder.finished, true);
    assert.equal(retried.ladder.flippedToFinished, true);
  });

  it('flips exactly once when two final reports overlap', async () => {
    // Both merge before either reaches the mutex. Judged from the stored rungs
    // around each merge, both would see a ladder unfinished before and
    // finished after, and both would claim the flip; the cue to send `vod`
    // is meant to fire once, from the report whose write finished the entry.
    const { gateway, service, stream } = await setup();
    await service.report(stream.id, LIVE_360, ON_STAGE);
    await service.report(stream.id, LIVE_720, ON_STAGE);
    const before = gateway.writes.length;

    const outcomes = await Promise.all([
      service.report(stream.id, FINAL_360, ON_STAGE),
      service.report(stream.id, FINAL_720, ON_STAGE),
    ]);

    const flipped = outcomes.filter((o) => o.ladder.flippedToFinished);
    assert.equal(flipped.length, 1);
    assert.equal(flipped[0]!.ladder.finished, true);
    assert.equal(flipped[0]!.ladder.duration, 62.5);
    assert.equal(gateway.writes.length, before + 2, 'one write per report');
    const last = entryAt(gateway, gateway.writes.at(-1)!.index, stream.topic);
    assert.deepEqual(last.renditions, [FINAL_360, FINAL_720]);
  });

  it('keeps a finished rung that reports itself live again on the same feed', async () => {
    // A rung's topic is derived from the declared topic and the rung name, so
    // it does not change between sessions. Until that rung reports a final
    // again, the recording it finished stays addressable on the entry.
    const { service, stream } = await setup();
    await service.report(stream.id, FINAL_360, ON_STAGE);

    const again = await service.report(stream.id, LIVE_360, ON_STAGE);

    assert.deepEqual(again.renditions, [FINAL_360]);
    assert.equal(again.ladder.finished, true);
  });

  it('is unfinished after a resume, and flips once when the new run ends', async () => {
    // The `live` report is what un-finishes the ladder, because the feeds the
    // rungs continue writing are the ones the last recording sits on. After it
    // the entry carries rungs without a recording, and the next set of final reports
    // has a flip to give the uploader for the second `vod`.
    const { gateway, service, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await service.report(stream.id, LIVE_360, ON_STAGE);
    await service.report(stream.id, LIVE_720, ON_STAGE);
    await service.report(stream.id, FINAL_360, ON_STAGE);
    const ended = await service.report(stream.id, FINAL_720, ON_STAGE);
    assert.equal(ended.ladder.flippedToFinished, true);
    await state.report(stream.id, { state: 'vod', recording: RECORDING_MASTER, duration: 62.5 }, ON_STAGE);

    const resumed = await state.report(stream.id, { state: 'live' }, ON_STAGE);

    const entry = entryAt(gateway, resumed.feed.index, stream.topic);
    assert.deepEqual(entry.renditions, [LIVE_360, LIVE_720], 'unfinished');

    const first = await service.report(stream.id, LIVE_720, ON_STAGE);
    assert.deepEqual(first.ladder, {
      finished: false,
      flippedToFinished: false,
      duration: null,
    });
    const second = await service.report(stream.id, FINAL_360, ON_STAGE);
    assert.equal(second.ladder.flippedToFinished, false);
    const last = await service.report(stream.id, FINAL_720, ON_STAGE);
    assert.deepEqual(last.ladder, {
      finished: true,
      flippedToFinished: true,
      duration: 62.5,
    });
  });

  it('answers each overlapping report with the ladder its own write put on the feed', async () => {
    // The uploader writes its master playlist from the ladder it is handed, so
    // an answer describing an older entry than the one this report wrote
    // would put an older master over a newer one. Each answer is the ladder
    // of the entry at the feed index it reports, and the later write carries
    // both rungs.
    const { gateway, service, stream } = await setup();

    const outcomes = await Promise.all([
      service.report(stream.id, LIVE_360, ON_STAGE),
      service.report(stream.id, LIVE_720, ON_STAGE),
    ]);

    for (const outcome of outcomes) {
      const entry = entryAt(gateway, outcome.publish.feed.index, stream.topic);
      assert.deepEqual(outcome.renditions, entry.renditions);
    }
    const [, later] = [...outcomes].sort((a, b) => a.publish.feed.index - b.publish.feed.index);
    assert.deepEqual(
      later!.renditions.map((r) => r.name),
      ['360p', '720p'],
    );
  });
});

/**
 * A rung report is the uploader's, so the entry names the uploader whatever
 * route it came through, and it carries the rung, the feed index of the
 * write that put it on the catalogue, and that rung as the write carried it.
 */
describe('LadderService audit', () => {
  it('records a rung report as the uploader, with the rung, the feed index and the rung the write carried', async () => {
    const { audit, service, stream } = await setup();
    audit.entries.length = 0;

    const outcome = await service.report(stream.id, FINAL_720, ON_STAGE);

    assert.deepEqual(audit.entries, [
      {
        actor: { kind: 'uploader' },
        action: 'stream.rendition.report',
        streamId: stream.id,
        topic: stream.topic,
        statusBefore: 'published',
        statusAfter: 'published',
        details: {
          rung: '720p',
          recording: RECORDING_720,
          duration: 62.5,
          feedIndex: outcome.publish.feed.index,
          entryRung: FINAL_720,
          finished: true,
          flippedToFinished: true,
        },
      },
    ]);
  });

  it('claims no transition when a live report lands between its read and its write', async () => {
    // At the start of an ABR broadcast the first rung and the `live` report
    // race. The ladder reads the row as `published`, the state report moves
    // it to `live`, and the ladder's write sees `live`. The transition is the
    // state report's to record; the rung's entry names the one status its
    // write saw, on both sides.
    const { store, renditions, audit, service, stream } = await setup();
    const upsert = renditions.upsert.bind(renditions);
    renditions.upsert = async (streamId, rendition) => {
      const row = await upsert(streamId, rendition);
      await store.markLive(streamId, ['published']);
      return row;
    };
    audit.entries.length = 0;

    await service.report(stream.id, LIVE_360, ON_STAGE);

    const [entry] = audit.withAction('stream.rendition.report');
    assert.equal(entry?.statusBefore, 'live');
    assert.equal(entry?.statusAfter, 'live');
  });

  it('records the rung as its write published it when a later report for that rung lands first', async () => {
    // This report stores 720p still live, then 720p's final report is stored
    // before the republish reads the ladder. The write carries the final
    // rung, as the catalogue should. The entry pairs this report's recording and
    // duration with that write, so it has to say what the write carried.
    const { renditions, audit, service, stream } = await setup();
    const upsert = renditions.upsert.bind(renditions);
    renditions.upsert = async (streamId, rendition) => {
      const row = await upsert(streamId, rendition);
      await upsert(streamId, FINAL_720);
      return row;
    };
    audit.entries.length = 0;

    const outcome = await service.report(stream.id, LIVE_720, ON_STAGE);

    assert.deepEqual(outcome.renditions, [FINAL_720], 'the catalogue has the later report');
    assert.deepEqual(audit.entries, [
      {
        actor: { kind: 'uploader' },
        action: 'stream.rendition.report',
        streamId: stream.id,
        topic: stream.topic,
        statusBefore: 'published',
        statusAfter: 'published',
        details: {
          rung: '720p',
          recording: null,
          duration: null,
          feedIndex: outcome.publish.feed.index,
          entryRung: FINAL_720,
          finished: true,
          flippedToFinished: true,
        },
      },
    ]);
  });

  it('names the status its write published when a live report lands while that write is on its way', async () => {
    // The republish reads the row as published and writes that. The live
    // report's row lands before the write is recorded, so the row the write
    // hands back says live; the transition is the state report's to record.
    const { store, gateway, audit, service, stream } = await setup();
    const write = gateway.write.bind(gateway);
    gateway.write = async (entries, index) => {
      const reference = await write(entries, index);
      await store.markLive(stream.id, ['published']);
      return reference;
    };
    audit.entries.length = 0;

    const outcome = await service.report(stream.id, LIVE_360, ON_STAGE);

    assert.equal(entryAt(gateway, outcome.publish.feed.index, stream.topic).state, 'scheduled');
    const [entry] = audit.withAction('stream.rendition.report');
    assert.equal(entry?.statusBefore, 'published');
    assert.equal(entry?.statusAfter, 'published');
  });

  it('records a rung that was stored but whose catalogue write failed, with the reason', async () => {
    const { gateway, audit, service, stream } = await setup();
    audit.entries.length = 0;
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => service.report(stream.id, LIVE_360, ON_STAGE), PublishFailedError);

    assert.deepEqual(
      audit.entries.map(({ actor, action, details }) => ({ actor, action, details })),
      [
        {
          actor: { kind: 'uploader' },
          action: 'stream.rendition.report',
          details: { rung: '360p', recording: null, duration: null, feedIndex: null, publishError: 'bee unreachable' },
        },
      ],
    );
  });
});
