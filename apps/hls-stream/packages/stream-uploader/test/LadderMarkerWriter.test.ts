import { BeeResponseError, PrivateKey, Topic } from '@ethersphere/bee-js';
import {
  ladderMarkerIdentifier,
  markerPeriodAt,
  markerPeriodStartMs,
  parseLadderMarker,
} from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BeePublisherPool } from '../src/libs/BeePublisherPool.js';
import { LadderMarkerWriter } from '../src/libs/LadderMarkerWriter.js';
import { ServiceMetrics } from '../src/libs/ServiceMetrics.js';
import { FakeClock } from './helpers/fakeClock.js';

const TEST_KEY = '0'.repeat(63) + '1';
const GROUP = 'ladder-group-1';
const OTHER_GROUP = 'ladder-group-2';
const RUNG_360 = 'rung-topic-360p';
const RUNG_720 = 'rung-topic-720p';

/** A wall clock 3.4 s into a period, so the first boundary is 6.6 s away. */
const START_MS = markerPeriodStartMs(175_983_840) + 3_400;
const PERIOD_MS = 10_000;

interface Upload {
  stamp: string;
  identifier: string;
  payload: string;
  deferred: boolean | undefined;
  wallMs: number;
  signal: AbortSignal | undefined;
}

type UploadBehaviour = (attempt: Upload) => Promise<void>;

interface Harness {
  clock: FakeClock;
  wallMs: () => number;
  setWallOffset: (offsetMs: number) => void;
  uploads: Upload[];
  metrics: ServiceMetrics;
  lines: { level: string; message: string }[];
  writer: LadderMarkerWriter;
  setBehaviour: (behaviour: UploadBehaviour) => void;
  writerRung: () => string | undefined;
}

function harness(): Harness {
  const clock = new FakeClock();
  let wallOffset = 0;
  const wallMs = () => START_MS + clock.now() + wallOffset;
  const uploads: Upload[] = [];
  let behaviour: UploadBehaviour = async () => {};
  let rungUsed: string | undefined;

  const bee = {
    soc: {
      makeWriter: (_signer: PrivateKey, requestOptions?: { signal?: AbortSignal }) => ({
        upload: async (
          stamp: string,
          identifier: { toHex(): string },
          data: Uint8Array,
          options?: { deferred?: boolean },
        ) => {
          const upload: Upload = {
            stamp,
            identifier: identifier.toHex(),
            payload: new TextDecoder().decode(data),
            deferred: options?.deferred,
            wallMs: wallMs(),
            signal: requestOptions?.signal,
          };
          uploads.push(upload);
          await behaviour(upload);
          return { reference: { toHex: () => 'ref' } };
        },
      }),
    },
  };
  const coordinator = { rung: '360p', url: 'http://coordinator.invalid', stamp: 'coordinator-stamp', bee };
  const publishers = {
    coordinator: () => {
      rungUsed = coordinator.rung;
      return coordinator;
    },
  } as unknown as BeePublisherPool;

  const metrics = new ServiceMetrics();
  const lines: { level: string; message: string }[] = [];
  const logger = {
    info: (message: string) => lines.push({ level: 'info', message }),
    warn: (message: string) => lines.push({ level: 'warn', message }),
    debug: (message: string) => lines.push({ level: 'debug', message }),
  };

  const writer = new LadderMarkerWriter({
    publishers,
    signer: new PrivateKey(TEST_KEY),
    segmentMs: 2_000,
    clock,
    wallClockMs: wallMs,
    metrics,
    logger,
  });

  return {
    clock,
    wallMs,
    setWallOffset: (offsetMs) => {
      wallOffset = offsetMs;
    },
    uploads,
    metrics,
    lines,
    writer,
    setBehaviour: (next) => {
      behaviour = next;
    },
    writerRung: () => rungUsed,
  };
}

function markerOf(upload: Upload) {
  const marker = parseLadderMarker(upload.payload);
  assert.ok(marker, `the uploaded payload must be a valid marker: ${upload.payload}`);
  return marker;
}

function topicHex(topic: string): string {
  return Topic.fromString(topic).toHex();
}

function counters(metrics: ServiceMetrics) {
  const { ladderMarkersWrittenTotal, ladderMarkersFailedTotal } = metrics.getCounters();
  return { written: ladderMarkersWrittenTotal, failed: ladderMarkersFailedTotal };
}

describe('LadderMarkerWriter', () => {
  it('writes nothing for a ladder that has published nothing', async () => {
    const h = harness();

    await h.clock.advance(5 * PERIOD_MS);

    assert.equal(h.uploads.length, 0);
    assert.equal(h.clock.pendingCount(), 0, 'no timer runs before a ladder has published');
  });

  it("writes the period's marker shortly after the next boundary, direct, through the master's publisher", async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 41);
    h.writer.recordPublished(GROUP, RUNG_720, 7);

    await h.clock.advance(6_000);
    assert.equal(h.uploads.length, 0, 'no marker inside the period the ladder started in');

    await h.clock.advance(PERIOD_MS - 6_000);

    assert.equal(h.uploads.length, 1);
    const [upload] = h.uploads;
    const period = 175_983_841;
    assert.equal(markerPeriodAt(upload.wallMs), period, 'written inside the period it names');
    assert.ok(upload.wallMs - markerPeriodStartMs(period) < 1_000, 'and shortly after its boundary');
    assert.equal(upload.identifier, ladderMarkerIdentifier(Topic.fromString(GROUP), period).toHex());
    assert.equal(upload.stamp, 'coordinator-stamp');
    assert.equal(h.writerRung(), '360p');
    assert.equal(upload.deferred, false);
    assert.deepEqual(markerOf(upload), {
      v: 2,
      period,
      writtenAt: upload.wallMs,
      rungs: { [topicHex(RUNG_360)]: 41, [topicHex(RUNG_720)]: 7 },
      segmentMs: 2_000,
    });
    assert.deepEqual(counters(h.metrics), { written: 1, failed: 0 });
  });

  it('writes one marker per period, each with the newest index every rung had published', async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 1);
    await h.clock.advance(PERIOD_MS);

    h.writer.recordPublished(GROUP, RUNG_360, 9);
    h.writer.recordPublished(GROUP, RUNG_720, 3);
    h.writer.recordPublished(GROUP, RUNG_360, 8);
    await h.clock.advance(PERIOD_MS);

    assert.equal(h.uploads.length, 2);
    assert.deepEqual(markerOf(h.uploads[0]).rungs, { [topicHex(RUNG_360)]: 1 });
    assert.deepEqual(
      markerOf(h.uploads[1]).rungs,
      { [topicHex(RUNG_360)]: 9, [topicHex(RUNG_720)]: 3 },
      'an older index arriving late never moves a rung backwards',
    );
    assert.notEqual(h.uploads[0].identifier, h.uploads[1].identifier);
  });

  it('abandons a write that cannot finish within its period, counts it, logs it once, and goes on', async () => {
    const h = harness();
    h.setBehaviour(
      (upload) =>
        new Promise((_, reject) => {
          upload.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    h.writer.recordPublished(GROUP, RUNG_360, 1);

    await h.clock.advance(PERIOD_MS);
    await h.clock.advance(PERIOD_MS);
    await h.clock.advance(PERIOD_MS);

    assert.equal(h.uploads.length, 3, 'every period is attempted once, none is rewritten');
    assert.equal(new Set(h.uploads.map((upload) => upload.identifier)).size, 3);
    assert.deepEqual(
      h.uploads.map((upload) => upload.signal?.aborted),
      [true, true, false],
      'each abandoned request is cancelled rather than left running, and the current one is still trying',
    );
    assert.deepEqual(counters(h.metrics), { written: 0, failed: 2 }, 'the third is still inside its period');

    h.setBehaviour(async () => {});
    await h.clock.advance(PERIOD_MS);
    await h.clock.advance(PERIOD_MS);

    assert.deepEqual(counters(h.metrics), { written: 2, failed: 3 });
    const warnings = h.lines.filter((line) => line.level === 'warn');
    assert.equal(warnings.length, 1, `a run of failures warns once, got: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0].message, new RegExp(GROUP));
    assert.ok(
      h.lines.some((line) => line.level === 'info' && /3/.test(line.message) && line.message.includes(GROUP)),
      'the recovery says how many periods had no marker',
    );
  });

  it('retries a transient failure inside the period and counts one marker', async () => {
    const h = harness();
    let attempts = 0;
    h.setBehaviour(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new BeeResponseError('POST', '/soc', 'Service Unavailable', undefined, 503, 'Service Unavailable');
      }
    });
    h.writer.recordPublished(GROUP, RUNG_360, 1);

    await h.clock.advance(PERIOD_MS);

    assert.equal(attempts, 2);
    assert.deepEqual(counters(h.metrics), { written: 1, failed: 0 });
  });

  it('gives up on a refusal retrying cannot fix without waiting out the period', async () => {
    const h = harness();
    h.setBehaviour(async () => {
      throw new BeeResponseError('POST', '/soc', 'Payment Required', undefined, 402, 'Payment Required');
    });
    h.writer.recordPublished(GROUP, RUNG_360, 1);

    await h.clock.advance(7_000);

    assert.equal(h.uploads.length, 1);
    assert.deepEqual(counters(h.metrics), { written: 0, failed: 1 });
  });

  it('never writes a period twice when the wall clock steps back', async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 1);
    await h.clock.advance(PERIOD_MS);
    assert.equal(h.uploads.length, 1);

    h.setWallOffset(-PERIOD_MS);
    await h.clock.advance(PERIOD_MS);
    await h.clock.advance(PERIOD_MS);

    const periods = h.uploads.map((upload) => markerOf(upload).period);
    assert.equal(new Set(periods).size, periods.length, `a period was written twice: ${periods.join(', ')}`);
  });

  it('stops when the ladder ends, and starts again when it publishes again', async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 1);
    await h.clock.advance(PERIOD_MS);
    assert.equal(h.uploads.length, 1);

    h.writer.endLadder(GROUP);
    await h.clock.advance(3 * PERIOD_MS);
    assert.equal(h.uploads.length, 1);
    assert.equal(h.clock.pendingCount(), 0);

    h.writer.recordPublished(GROUP, RUNG_360, 2);
    await h.clock.advance(PERIOD_MS);
    assert.equal(h.uploads.length, 2);
  });

  it('keeps each ladder on its own markers', async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 4);
    h.writer.recordPublished(OTHER_GROUP, RUNG_720, 9);

    await h.clock.advance(PERIOD_MS);

    assert.equal(h.uploads.length, 2);
    const byIdentifier = new Map(h.uploads.map((upload) => [upload.identifier, markerOf(upload).rungs]));
    const period = 175_983_841;
    assert.deepEqual(byIdentifier.get(ladderMarkerIdentifier(Topic.fromString(GROUP), period).toHex()), {
      [topicHex(RUNG_360)]: 4,
    });
    assert.deepEqual(byIdentifier.get(ladderMarkerIdentifier(Topic.fromString(OTHER_GROUP), period).toHex()), {
      [topicHex(RUNG_720)]: 9,
    });
  });

  it('stops every ladder at once', async () => {
    const h = harness();
    h.writer.recordPublished(GROUP, RUNG_360, 1);
    h.writer.recordPublished(OTHER_GROUP, RUNG_360, 1);

    h.writer.stop();
    await h.clock.advance(3 * PERIOD_MS);

    assert.equal(h.uploads.length, 0);
    assert.equal(h.clock.pendingCount(), 0);
  });
});
