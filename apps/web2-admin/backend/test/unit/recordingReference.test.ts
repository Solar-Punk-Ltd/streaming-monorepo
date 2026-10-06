/**
 * A recording named by reference: an uploader on time windows uploads each recording playlist once as bytes and
 * reports its reference as `recording`, where an uploader on feeds reports the final manifest's feed `index`. Unit
 * test against the in-memory ports, no Bee and no database. `pnpm test`.
 *
 * Both kinds of report are taken until the last uploader on feeds is gone, so the second half of this file pins that
 * an `index` report reads, stores and lists exactly as it did before `recording` existed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FeedStreamEntry, Rendition } from '@streaming-monorepo/web2-admin-common';

import { toStream } from '../../src/api/presenters.js';
import { FakeFeedGateway } from '../../src/domain/FakeFeedGateway.js';
import type { FeedIdentity } from '../../src/domain/feedIdentity.js';
import { LadderService } from '../../src/domain/LadderService.js';
import { PublishService } from '../../src/domain/PublishService.js';
import { stageFitsRecording, stageLockFor } from '../../src/domain/StreamService.js';
import { publishedStatusFor } from '../../src/domain/streamState.js';
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
  topicHex: 'cf'.repeat(32),
};

const RECORDING = 'ab'.repeat(32);
const RECORDING_360 = 'c3'.repeat(32);
const RECORDING_720 = 'c7'.repeat(32);

function rung(name: string, height: number, final?: Partial<Pick<Rendition, 'index' | 'recording' | 'duration'>>) {
  return {
    name,
    width: (height * 16) / 9,
    height,
    topic: `bbbbbbbb-0000-4000-8000-0000000${String(height).padStart(5, '0')}`,
    bandwidth: height * 4000,
    avgBandwidth: height * 3000,
    ...(final ?? {}),
  } satisfies Rendition;
}

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
  const state = new StreamStateService(store, publishService, audit);
  const ladder = new LadderService(store, renditions, publishService, audit);
  const stream = store.add(streamRow());
  await publishService.publish(TEST_OPERATOR, stream.id);
  return { store, renditions, gateway, audit, state, ladder, publishService, stream };
}

function entryAt(gateway: FakeFeedGateway, index: number, topic: string): FeedStreamEntry {
  const write = gateway.writes.find((w) => w.index === index);
  assert.ok(write, `a write at index ${index}`);
  const entry = (write.entries as FeedStreamEntry[]).find((e) => e.topic === topic);
  assert.ok(entry, `an entry for ${topic} at index ${index}`);
  return entry;
}

describe('a state report naming its recording by reference', () => {
  it('stores the reference and lists it on the vod entry, with no index', async () => {
    const { store, gateway, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    const outcome = await state.report(stream.id, { state: 'vod', recording: RECORDING, duration: 61.5 }, ON_STAGE);

    const row = store.rows.get(stream.id)!;
    assert.equal(row.status, 'vod');
    assert.equal(row.recording_ref, RECORDING);
    assert.equal(row.manifest_index, null);
    assert.equal(row.duration_seconds, 61.5);
    const entry = entryAt(gateway, outcome.feed.index, stream.topic);
    assert.equal(entry.state, 'vod');
    assert.equal(entry.recording, RECORDING);
    assert.equal(entry.duration, 61.5);
    assert.equal('index' in entry, false, 'an entry naming its recording by reference carries no index');
  });

  it('audits the reference it was given and the one its write listed', async () => {
    const { audit, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    audit.entries.length = 0;

    const outcome = await state.report(stream.id, { state: 'vod', recording: RECORDING, duration: 61.5 }, ON_STAGE);

    assert.deepEqual(
      audit.entries.map((entry) => entry.details),
      [
        {
          recording: RECORDING,
          duration: 61.5,
          feedIndex: outcome.feed.index,
          entryStatus: 'vod',
          entryRecording: { index: null, recording: RECORDING, duration: 61.5 },
        },
      ],
    );
  });

  it('clears the reference from the row when the broadcast goes live again', async () => {
    const { store, gateway, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await state.report(stream.id, { state: 'vod', recording: RECORDING, duration: 61.5 }, ON_STAGE);

    const outcome = await state.report(stream.id, { state: 'live' }, ON_STAGE);

    assert.equal(store.rows.get(stream.id)!.recording_ref, null);
    assert.equal('recording' in entryAt(gateway, outcome.feed.index, stream.topic), false);
  });

  it('holds the recording for what a held recording decides: listed as vod, the stage locked to its owner', () => {
    const held = streamRow({ status: 'draft', recording_ref: RECORDING, duration_seconds: 61.5 });

    assert.equal(publishedStatusFor(held), 'vod');
    assert.equal(stageLockFor(held, null), 'recording');
    assert.equal(stageFitsRecording(held, { owner: 'f'.repeat(40) }), false);
    assert.equal(toStream(held).recording, RECORDING);
  });
});

describe('a rendition report naming its recording by reference', () => {
  it('stores each rung reference, lists it on the entry and finishes the ladder on them', async () => {
    const { renditions, gateway, ladder, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await ladder.report(stream.id, rung('360p', 360), ON_STAGE);
    await ladder.report(stream.id, rung('720p', 720), ON_STAGE);

    const first = await ladder.report(
      stream.id,
      rung('360p', 360, { recording: RECORDING_360, duration: 61 }),
      ON_STAGE,
    );
    assert.equal(first.ladder.finished, false);
    const last = await ladder.report(
      stream.id,
      rung('720p', 720, { recording: RECORDING_720, duration: 62.5 }),
      ON_STAGE,
    );

    assert.deepEqual(last.ladder, { finished: true, flippedToFinished: true, duration: 62.5 });
    const rows = await renditions.listByStream(stream.id);
    assert.deepEqual(
      rows.map((row) => [row.name, row.recording_ref, row.manifest_index, row.duration_seconds]),
      [
        ['360p', RECORDING_360, null, 61],
        ['720p', RECORDING_720, null, 62.5],
      ],
    );
    const listed = entryAt(gateway, last.publish.feed.index, stream.topic).renditions ?? [];
    assert.deepEqual(
      listed.map((r) => [r.name, r.recording, r.duration, 'index' in r]),
      [
        ['360p', RECORDING_360, 61, false],
        ['720p', RECORDING_720, 62.5, false],
      ],
    );
  });

  it('keeps a finished rung reference when the rung reports again without one on the same topic', async () => {
    const { ladder, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await ladder.report(stream.id, rung('360p', 360, { recording: RECORDING_360, duration: 61 }), ON_STAGE);

    const again = await ladder.report(stream.id, rung('360p', 360), ON_STAGE);

    assert.deepEqual(
      again.renditions.map((r) => [r.name, r.recording, r.duration]),
      [['360p', RECORDING_360, 61]],
    );
    assert.equal(again.ladder.finished, true);
  });

  it('clears every rung reference when the broadcast goes live again', async () => {
    const { renditions, ladder, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await ladder.report(stream.id, rung('360p', 360, { recording: RECORDING_360, duration: 61 }), ON_STAGE);
    await state.report(stream.id, { state: 'vod', recording: RECORDING, duration: 61 }, ON_STAGE);

    await state.report(stream.id, { state: 'live' }, ON_STAGE);

    const rows = await renditions.listByStream(stream.id);
    assert.deepEqual(
      rows.map((row) => [row.recording_ref, row.manifest_index, row.duration_seconds]),
      [[null, null, null]],
    );
  });
});

describe('an index report, unchanged', () => {
  it('stores and lists the index as before, with no recording anywhere', async () => {
    const { store, gateway, ladder, state, stream } = await setup();
    await state.report(stream.id, { state: 'live' }, ON_STAGE);
    await ladder.report(stream.id, rung('360p', 360, { index: 10, duration: 61 }), ON_STAGE);

    const outcome = await state.report(stream.id, { state: 'vod', index: 7, duration: 61 }, ON_STAGE);

    assert.equal(store.rows.get(stream.id)!.recording_ref, null);
    const entry = entryAt(gateway, outcome.feed.index, stream.topic);
    assert.equal(entry.index, 7);
    assert.equal('recording' in entry, false);
    assert.deepEqual(entry.renditions?.[0], rung('360p', 360, { index: 10, duration: 61 }));
    assert.equal(toStream(store.rows.get(stream.id)!).recording, null);
  });
});
