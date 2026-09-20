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

import type {
  FeedStreamEntry,
  Rendition,
} from '@streaming-monorepo/web2-admin-common';

import { toIngestLookup } from '../../src/api/presenters.js';
import {
  InvalidStateTransitionError,
  StreamNotFoundError,
} from '../../src/domain/errors/index.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { StreamStateService } from '../../src/domain/StreamStateService.js';

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

/**
 * A rung as the uploader reports it. The topic is derived from the stream's
 * declared topic and the rung name, so it is the same across sessions — what
 * makes the merge keep a finished record rather than drop it.
 */
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
  const state = new StreamStateService(store, publishService);
  const ladder = new LadderService(store, renditions, publishService);
  const stream = store.add(streamRow());
  await publishService.publish(stream.id, TEST_USER_ID);
  return { store, renditions, gateway, state, ladder, stream };
}

describe('StreamStateService.lookupByIngest lifecycle negotiation', () => {
  it('keeps legacy lookup compatible and hides managed rows from old uploaders', async () => {
    const { state, store, stream } = await setup();
    const legacy = await state.lookupByIngest('video', stream.topic);
    assert.equal(legacy.id, stream.id);

    const managed = store.add(
      streamRow({
        status: 'published',
        lifecycle_version: 1,
        lifecycle_revision: 4,
        current_run_number: 1,
        lifecycle_state: 'ready',
        lifecycle_permission: 'open',
        lifecycle_uploader_id: 'srs-main',
      }),
    );
    await assert.rejects(
      state.lookupByIngest('video', managed.topic),
      StreamNotFoundError,
    );
    assert.equal(
      (await state.lookupByIngest('video', managed.topic, '1')).id,
      managed.id,
    );
    const expectedRenditions = [
      {
        name: '720p',
        topic: '22222222-2222-4222-8222-222222222222',
        width: 1280,
        height: 720,
        bandwidth: 2_800_000,
        avgBandwidth: 2_500_000,
      },
    ];
    assert.deepEqual(toIngestLookup(managed, true, expectedRenditions), {
      id: managed.id,
      topic: managed.topic,
      owner: managed.owner,
      mediaType: 'video',
      title: managed.title,
      status: 'published',
      publishKey: managed.publish_key,
      lifecycleVersion: 1,
      mode: 'managed',
      lifecycle: {
        revision: 4,
        runNumber: 1,
        state: 'ready',
        permission: 'open',
        uploaderId: 'srs-main',
      },
      expectedRenditions,
    });
    const negotiatedLegacy = toIngestLookup(stream, true);
    assert.ok('mode' in negotiatedLegacy);
    assert.equal(negotiatedLegacy.mode, 'legacy');
    assert.equal('expectedRenditions' in negotiatedLegacy, false);
    await assert.rejects(
      state.lookupByIngest('video', managed.topic, '2'),
      StreamNotFoundError,
    );
  });
});

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
      (err: unknown) =>
        err instanceof InvalidStateTransitionError && err.from === 'draft',
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
