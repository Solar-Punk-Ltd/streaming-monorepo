/**
 * The state report end to end, against the in-memory ports. Unit test — no
 * Bee, no database. `pnpm test`.
 *
 * The case with weight here is a broadcast that goes live again after it
 * ended. Every feed of a declared stream outlives the sessions written to it,
 * so a reconnected encoder continues them above the previous head; the entry
 * must stop advertising the recording that has been superseded, on the row and
 * on every rung, and the ladder must be back to unfinished so the next set of
 * final reports can flip it again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedStreamEntry, Rendition } from '@streaming-monorepo/web2-admin-common';

import { InvalidStateTransitionError, PublishFailedError } from '../../src/domain/errors/index.js';
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
  streamRow,
  TEST_OPERATOR,
  TEST_OWNER,
} from './support/fakes.js';

const feed: FeedIdentity = {
  owner: TEST_OWNER,
  topic: 'swarm-stream',
  topicHex: 'cfbbc155d709547b198638d0fb11d733359561538d8bd606a9ab257354d13bcc',
};

/**
 * A rung as the uploader reports it. The topic is derived from the stream's
 * declared topic and the rung name, so it is the same across sessions — what
 * makes the merge keep a finished record rather than drop it.
 */
function rung(name: string, height: number, final?: { index: number; duration: number }): Rendition {
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

async function setup() {
  const renditions = new FakeRenditionStore();
  const store = new FakeStreamStore(renditions);
  const gateway = new FakeFeedGateway();
  const audit = new InMemoryAuditLog();
  const publishService = new PublishService(store, renditions, new FakeFeedWriteLog(), gateway, feed, audit);
  const state = new StreamStateService(store, publishService, audit);
  const ladder = new LadderService(store, renditions, publishService, audit);
  const stream = store.add(streamRow());
  await publishService.publish(TEST_OPERATOR, stream.id);
  return { store, renditions, gateway, audit, state, ladder, stream };
}

/** The stream's entry as the write at `index` left it on the feed. */
function entryAt(gateway: FakeFeedGateway, index: number, topic: string): FeedStreamEntry {
  const write = gateway.writes.find((w) => w.index === index);
  assert.ok(write, `a write at index ${index}`);
  const entry = (write.entries as FeedStreamEntry[]).find((e) => e.topic === topic);
  assert.ok(entry, `an entry for ${topic} at index ${index}`);
  return entry;
}

/** A whole broadcast: both rungs live, both final, then the `vod` report. */
async function broadcast(
  ladder: LadderService,
  state: StreamStateService,
  id: string,
  vod: { index: number; duration: number },
) {
  await state.report(id, { state: 'live' });
  await ladder.report(id, LIVE_360);
  await ladder.report(id, LIVE_720);
  await ladder.report(id, FINAL_360);
  await ladder.report(id, FINAL_720);
  await state.report(id, { state: 'vod', ...vod });
}

describe('StreamStateService.report', () => {
  it('refuses a stream nobody has announced', async () => {
    const { store, state } = await setup();
    const draft = store.add(streamRow());

    await assert.rejects(
      () => state.report(draft.id, { state: 'live' }),
      (err: unknown) => err instanceof InvalidStateTransitionError && err.from === 'draft',
    );
  });

  it('un-finishes the row when a broadcast goes live again', async () => {
    const { store, state, ladder, stream } = await setup();
    await broadcast(ladder, state, stream.id, { index: 7, duration: 62.5 });

    const ended = store.get(stream.id);
    assert.equal(ended.status, 'vod');
    assert.equal(ended.manifest_index, 7);
    assert.ok(ended.ended_at);

    await state.report(stream.id, { state: 'live' });

    const resumed = store.get(stream.id);
    assert.equal(resumed.status, 'live');
    assert.equal(resumed.manifest_index, null, 'the recording is superseded');
    assert.equal(resumed.duration_seconds, null);
    assert.equal(resumed.ended_at, null);
    assert.ok(resumed.live_since, 'a fresh live run, stamped as one');
  });

  it('un-finishes every rung with it, index and duration together', async () => {
    const { renditions, state, ladder, stream } = await setup();
    await broadcast(ladder, state, stream.id, { index: 7, duration: 62.5 });
    assert.deepEqual(
      (await renditions.listByStream(stream.id)).map((r) => r.manifest_index),
      [10, 12],
    );

    await state.report(stream.id, { state: 'live' });

    for (const row of await renditions.listByStream(stream.id)) {
      assert.equal(row.manifest_index, null, row.name);
      assert.equal(row.duration_seconds, null, row.name);
    }
  });

  it('republishes the entry as live, with no index on it or on its rungs', async () => {
    const { gateway, state, ladder, stream } = await setup();
    await broadcast(ladder, state, stream.id, { index: 7, duration: 62.5 });

    const outcome = await state.report(stream.id, { state: 'live' });

    const entry = entryAt(gateway, outcome.feed.index, stream.topic);
    assert.equal(entry.state, 'live');
    assert.equal(entry.index, undefined);
    assert.equal(entry.duration, undefined);
    assert.deepEqual(entry.renditions, [LIVE_360, LIVE_720]);
  });

  it('leaves a repeated live report alone, rungs included', async () => {
    // The uploader retries, and a `live` arriving twice in one run must not
    // throw away rungs that finalized between the two.
    const { store, renditions, state, ladder, stream } = await setup();
    await state.report(stream.id, { state: 'live' });
    const liveSince = store.get(stream.id).live_since;
    await ladder.report(stream.id, FINAL_360);

    await state.report(stream.id, { state: 'live' });

    assert.deepEqual(store.get(stream.id).live_since, liveSince);
    assert.deepEqual(
      (await renditions.listByStream(stream.id)).map((r) => r.manifest_index),
      [10],
    );
  });

  it('clears nothing when the conditional write refuses the transition', async () => {
    // The rule is checked twice — once to answer the 409, once as the write's
    // own condition, so two reports racing cannot both win. A write that loses
    // that race must leave the recording and the ladder exactly as they were.
    const { store, renditions, state, ladder, stream } = await setup();
    await broadcast(ladder, state, stream.id, { index: 7, duration: 62.5 });

    const refused = await store.markLive(stream.id, ['published', 'live']);

    assert.equal(refused, null);
    assert.equal(store.get(stream.id).status, 'vod');
    assert.equal(store.get(stream.id).manifest_index, 7);
    assert.deepEqual(
      (await renditions.listByStream(stream.id)).map((r) => r.manifest_index),
      [10, 12],
    );
  });
});

/**
 * A state report is the uploader's: the internal route has no session, and
 * the service names the uploader itself. One entry per report, with the
 * transition it made and the feed index of the republish that followed it —
 * the republish adds no entry of its own.
 */
describe('StreamStateService audit', () => {
  it('records a live report as the uploader, published → live, and nothing for the republish', async () => {
    const { audit, state, stream } = await setup();
    audit.entries.length = 0;

    const outcome = await state.report(stream.id, { state: 'live' });

    assert.deepEqual(audit.entries, [
      {
        actor: { kind: 'uploader' },
        action: 'stream.state.live',
        streamId: stream.id,
        topic: stream.topic,
        statusBefore: 'published',
        statusAfter: 'live',
        details: { feedIndex: outcome.feed.index },
      },
    ]);
  });

  it('records a vod report with where the recording is', async () => {
    const { audit, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' });
    audit.entries.length = 0;

    const outcome = await state.report(stream.id, { state: 'vod', index: 7, duration: 62.5 });

    assert.deepEqual(audit.entries, [
      {
        actor: { kind: 'uploader' },
        action: 'stream.state.vod',
        streamId: stream.id,
        topic: stream.topic,
        statusBefore: 'live',
        statusAfter: 'vod',
        details: { index: 7, duration: 62.5, feedIndex: outcome.feed.index },
      },
    ]);
  });

  it('records the status its write published when a later report lands before the write reads the row', async () => {
    // The live report's row is written, then the vod report's, and only then
    // does the republish read the row inside the mutex. Its write carries
    // vod, as the catalogue should; the live report's entry names that write,
    // so it has to say what the write published.
    const { store, gateway, audit, state, stream } = await setup();
    const markLive = store.markLive.bind(store);
    store.markLive = async (id, allowedFrom) => {
      const row = await markLive(id, allowedFrom);
      await store.markVod(id, ['live'], 7, 62.5);
      return row;
    };
    audit.entries.length = 0;

    const outcome = await state.report(stream.id, { state: 'live' });

    assert.equal(entryAt(gateway, outcome.feed.index, stream.topic).state, 'vod', 'the catalogue has the later state');
    assert.deepEqual(audit.entries, [
      {
        actor: { kind: 'uploader' },
        action: 'stream.state.live',
        streamId: stream.id,
        topic: stream.topic,
        statusBefore: 'published',
        statusAfter: 'live',
        details: { feedIndex: outcome.feed.index, entryStatus: 'vod' },
      },
    ]);
  });

  it('records the status its write published when a later report lands while that write is on its way', async () => {
    // The republish reads the row as live and writes a live entry. The vod
    // report's row lands before that write is recorded, so the row the write
    // hands back already says vod; the write itself published live.
    const { store, gateway, audit, state, stream } = await setup();
    const write = gateway.write.bind(gateway);
    gateway.write = async (entries, index) => {
      const reference = await write(entries, index);
      await store.markVod(stream.id, ['live'], 7, 62.5);
      return reference;
    };
    audit.entries.length = 0;

    const outcome = await state.report(stream.id, { state: 'live' });

    assert.equal(entryAt(gateway, outcome.feed.index, stream.topic).state, 'live');
    assert.equal(outcome.stream.status, 'vod', 'the row moved on while the write was on its way');
    const [entry] = audit.withAction('stream.state.live');
    assert.deepEqual(entry?.details, { feedIndex: outcome.feed.index, entryStatus: 'live' });
  });

  it('records the transition when the republish after it failed, with the reason', async () => {
    // The state is persisted before the feed write, so it did move; the entry
    // says so, and that the catalogue has not caught up.
    const { store, gateway, audit, state, stream } = await setup();
    audit.entries.length = 0;
    gateway.failNextWrite = new Error('bee unreachable');

    await assert.rejects(() => state.report(stream.id, { state: 'live' }), PublishFailedError);

    assert.equal(store.get(stream.id).status, 'live');
    assert.deepEqual(
      audit.entries.map(({ action, statusBefore, statusAfter, details }) => ({
        action,
        statusBefore,
        statusAfter,
        details,
      })),
      [
        {
          action: 'stream.state.live',
          statusBefore: 'published',
          statusAfter: 'live',
          details: { feedIndex: null, publishError: 'bee unreachable' },
        },
      ],
    );
  });
});
