/**
 * A rung is live when its playlist publishes, not when its segments upload.
 *
 * ⛔⛔⛔ **Seen on the dev stage 2026-10-14.** A stream that had broadcast before was broadcast again,
 * and two or three of its four rungs published no live playlist for the whole broadcast while every
 * one of their segments landed. The master kept offering all four, because the liveness behind it was
 * fed by landed segments. A viewer cannot play a segment no playlist names, so a rung in that state is
 * as dead to a viewer as one whose transcoder stopped, and it has to leave the master the same way.
 *
 * Driven through real uploaders, one per rung, sharing one ladder's liveness the way the registry
 * holds it. The first broadcast is healthy on every rung, as it was on the stage, which is what puts
 * every rung on record as having delivered. The second broadcast reuses the ladder, and one rung's
 * playlist writes are refused every time while its segment uploads all land. The last case runs that
 * broken rung in a fresh process instead, where it has never delivered anything.
 */

import { Bee } from '@ethersphere/bee-js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advertisableRenditions, LadderLivenessBook, RUNG_DEATH_LAG_SEGMENTS } from '../src/libs/LadderLiveness.js';
import { StreamUploader } from '../src/libs/StreamUploader.js';
import { MEDIA_TYPE_VIDEO } from '../src/types.js';

import {
  makeFakeBee,
  makeFakeCatalog,
  makeFakeRecoveryStore,
  rejectImmediately,
  TEST_ANCHOR,
  testPublisher,
} from './helpers/fakes.js';

const TEST_STREAM_KEY = `${'0'.repeat(63)}1`;
const GROUP = 'group-1';

const RUNGS = [
  { name: '360p', width: 640, height: 360, configuredKbps: 800 },
  { name: '480p', width: 854, height: 480, configuredKbps: 1400 },
  { name: '720p', width: 1280, height: 720, configuredKbps: 2800 },
  { name: '1080p', width: 1920, height: 1080, configuredKbps: 5000 },
];
const BROKEN_RUNG = '1080p';

/** Comfortably past the point the rule drops a rung, so the verdict does not rest on an off-by-one. */
const SEGMENTS_PER_BROADCAST = 3 * RUNG_DEATH_LAG_SEGMENTS;

const emptyFeed = () => null;

function healthyBee(): Bee {
  return makeFakeBee({ feedHead: emptyFeed });
}

/** Every segment lands, every playlist write is refused. */
function playlistRefusingBee(): Bee {
  return makeFakeBee({ feedHead: emptyFeed, uploadPayload: rejectImmediately });
}

function rungUploader(
  book: LadderLivenessBook,
  rung: (typeof RUNGS)[number],
  bee: Bee,
  broadcast: number,
): StreamUploader {
  const registry = makeFakeCatalog({
    recordRungDelivered: (group: string, name: string) => book.recordDelivered(group, name),
    recordRungUploadFailed: (group: string, name: string) => book.recordUploadFailed(group, name),
  });
  return new StreamUploader({
    anchor: TEST_ANCHOR,
    publisher: testPublisher(bee),
    streamCatalog: registry,
    recoveryStore: makeFakeRecoveryStore(),
    streamKey: TEST_STREAM_KEY,
    redundancyLevel: 1,
    streamId: `stream-${broadcast}-${rung.name}`,
    streamTopic: `topic-${rung.name}`,
    mediatype: MEDIA_TYPE_VIDEO,
    ladder: { group: GROUP, rung },
  });
}

async function drain(uploader: StreamUploader): Promise<void> {
  await uploader.segmentQueue.onIdle();
  await (uploader as unknown as { manifestQueue: { onIdle(): Promise<void> } }).manifestQueue.onIdle();
}

/** One segment per rung per round, each drained before the next, as one encoder cuts a ladder. */
async function broadcast(uploaders: readonly StreamUploader[]): Promise<void> {
  for (let segment = 0; segment < SEGMENTS_PER_BROADCAST; segment++) {
    for (const uploader of uploaders) {
      uploader.handleSegment(segment, 2, Buffer.from(`segment-${segment}`));
      await drain(uploader);
    }
  }
}

function advertised(book: LadderLivenessBook): string[] {
  return advertisableRenditions(RUNGS, book.of(GROUP)).map((rung) => rung.name);
}

describe('rung liveness follows what a viewer is served', () => {
  it('drops a rung whose segments land but whose playlist never publishes, and keeps its siblings', async () => {
    const book = new LadderLivenessBook();
    await broadcast(RUNGS.map((rung) => rungUploader(book, rung, healthyBee(), 1)));
    assert.deepEqual(
      advertised(book),
      RUNGS.map((rung) => rung.name),
      'a healthy first broadcast offers every rung',
    );

    await broadcast(
      RUNGS.map((rung) =>
        rungUploader(book, rung, rung.name === BROKEN_RUNG ? playlistRefusingBee() : healthyBee(), 2),
      ),
    );

    const names = RUNGS.map((rung) => rung.name);
    assert.equal(
      book.of(GROUP).hasStopped(BROKEN_RUNG, names),
      true,
      'a rung no viewer can play, because no playlist names its segments, has stopped',
    );
    assert.deepEqual(
      advertised(book),
      names.filter((name) => name !== BROKEN_RUNG),
      'the master offers the three rungs that publish, and not the one that does not',
    );
  });

  /**
   * ⛔ The same rung in a fresh process, with no earlier broadcast to put it on record. A rung that never
   * delivered read a lag of zero whatever its siblings did, so this one stayed in the master for the
   * whole broadcast (2026-10-14). It is measured from where the ladder stood at its first failure.
   */
  it('drops a rung whose playlist never publishes from the first second of a fresh process', async () => {
    const book = new LadderLivenessBook();

    await broadcast(
      RUNGS.map((rung) =>
        rungUploader(book, rung, rung.name === BROKEN_RUNG ? playlistRefusingBee() : healthyBee(), 1),
      ),
    );

    const names = RUNGS.map((rung) => rung.name);
    assert.equal(
      book.of(GROUP).hasStopped(BROKEN_RUNG, names),
      true,
      'a rung that has published no playlist all broadcast, while its siblings publish, has stopped',
    );
    assert.deepEqual(
      advertised(book),
      names.filter((name) => name !== BROKEN_RUNG),
      'the master offers the three rungs that publish, and not the one that never has',
    );
  });
});
