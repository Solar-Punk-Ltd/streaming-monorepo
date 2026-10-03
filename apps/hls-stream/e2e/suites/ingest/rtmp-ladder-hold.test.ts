import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine, rungStreamsIn, SRS_RUNG_PUBLISHED, SRS_RUNG_UNPUBLISHED } from '../../src/harness/engine.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  continuationRefusal,
  deliveredAfterReturn,
  everyStreamDelivered,
  printObservations,
  requirePublishing,
  secondsReading,
  secondsToFirstSeam,
} from '../../src/harness/ingest.js';
import { announcedSessionTopics } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { INGEST_RTMP, unsupportedIngestReason } from '../../src/ingestProtocol.js';

/**
 * Ingest: a ladder whose RTMP source drops and comes back within the encoder hold keeps the same encoders.
 *
 * With the ABR ladder on, SRS runs one encoder per rung, each republishing its rung over loopback RTMP. The fork's
 * encoder hold keeps those encoders running for `ABR_UNPUBLISH_HOLD` seconds after the source drops, 12 by default, so
 * a broadcaster back inside it gets its picture back on the same encoders rather than on a fresh set started after
 * SRS stopped the old one. The hold sits in the source, so it covers an RTMP broadcaster as it covers an SRT one.
 *
 * What it looks like from the uploader: no rung's own publish ends or starts across the drop, because a held encoder
 * keeps its rung's publish open, and every rung places one seam when the source comes back. **The absence of those
 * rung lines is only evidence if they can be read at all**, so the suite proves it can: every rung's publish line is
 * read before the drop, and once the broadcaster leaves for good, every rung's unpublish line is read when the hold
 * runs out.
 *
 * Skipped on a stage without a ladder, where there are no encoders to hold.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in CI runs these.
 */

const WARMUP_SEGMENTS = 3;
/**
 * Segments each rung uploads after its seam, every one of them made from the returned source, so the held encoders
 * are shown carrying the broadcast rather than landing a single segment.
 */
const RESUMED_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 180_000;
const DISCONNECT_WAIT_MS = 60_000;
/** When the broadcaster comes back: well inside the 12 second default hold. A scenario input and not a reading. */
const RETURN_AFTER_DROP_MS = 2_000;
/** The hold plus SRS's 3 second check, the encoders' own stop and the rung hooks, with room. */
const HOLD_RUNS_OUT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

function skipReason(): string | false {
  const unsupported = unsupportedIngestReason(cfg.engine, INGEST_RTMP);
  if (unsupported !== null) {
    return unsupported;
  }
  return cfg.abrEnabled ? false : 'ABR_ENABLED is off on this deployment, so there are no rung encoders to hold';
}

/** Whether `streamIds` names a stream for every rung the deployment declares. */
function namesEveryRung(streamIds: readonly string[]): boolean {
  return cfg.abrRungs.every((rung) => streamIds.some((id) => id.endsWith(`_${rung}`)));
}

describe('ingest: a ladder keeps its encoders through a short drop of its RTMP source', { skip: skipReason() }, () => {
  const host = makeHost(cfg);
  const engine = getEngine(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const rungs = cfg.abrRungs.length;
  const publishers: Publisher[] = [];
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publishers.push(startPublisher(cfg, { protocol: INGEST_RTMP }));
  });

  after(async () => {
    await Promise.all(publishers.map((publisher) => publisher.stop()));
  });

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

  it('carries every rung across the drop on the encoders it had, with one seam each', async () => {
    assert.ok(rungs > 1, 'ABR_LADDER names fewer than two rungs, so a held ladder cannot be told from a single stream');
    const [first] = publishers;
    await waitFor(
      async () => {
        requirePublishing(first, 'the RTMP source publisher');
        return everyStreamDelivered(await log(), rungs, WARMUP_SEGMENTS);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `warmup: each of ${rungs} rungs uploads ${WARMUP_SEGMENTS} segments`,
      },
    );
    const beforeDrop = await log();
    assert.ok(
      namesEveryRung(rungStreamsIn(beforeDrop, SRS_RUNG_PUBLISHED)),
      'no rung published line was read for every rung before the drop, so this suite could not see a rung restart ' +
        'after it either: the uploader writes them as `[SRS] Rung published: <stream>`',
    );
    const topicsBefore = new Set(announcedSessionTopics(beforeDrop));

    const droppedAt = await host.nowIso();
    await first.stop();
    await waitFor(async () => engine.unpublishedMarker.test(await host.logsSince(uploader, droppedAt)), {
      timeoutMs: DISCONNECT_WAIT_MS,
      intervalMs: 1_000,
      label: 'the uploader is told the ladder’s RTMP source left',
    });

    await sleep(RETURN_AFTER_DROP_MS);
    const returnedAt = await host.nowIso();
    const second = startPublisher(cfg, { protocol: INGEST_RTMP });
    publishers.push(second);

    await waitFor(
      async () => {
        requirePublishing(second, 'the returning RTMP source publisher');
        return deliveredAfterReturn(await host.logsSince(uploader, droppedAt), rungs, RESUMED_SEGMENTS);
      },
      {
        timeoutMs: SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `each of ${rungs} rungs places its seam and uploads ${RESUMED_SEGMENTS} segments after it`,
      },
    );

    const sinceDrop = await host.logsSince(uploader, droppedAt);
    assert.deepEqual(
      rungStreamsIn(sinceDrop, SRS_RUNG_UNPUBLISHED),
      [],
      'a rung’s publish ended during the drop, so its encoder was not held',
    );
    assert.deepEqual(
      rungStreamsIn(sinceDrop, SRS_RUNG_PUBLISHED),
      [],
      'a rung published again after the drop, so its encoder was restarted rather than held',
    );
    const refusal = continuationRefusal(await log(), sinceDrop, topicsBefore, rungs);
    assert.equal(refusal, null, refusal ?? '');

    const backAfterS = secondsToFirstSeam(await host.logsSince(uploader, returnedAt), returnedAt);
    printObservations('rtmp-ladder-hold', [
      `from the source's return to the first rung segment in a playlist: ${secondsReading(backAfterS)}`,
    ]);
  });

  /** What makes the two empty lists above evidence rather than a reader that sees nothing. */
  it('reads every rung’s unpublish once the source leaves for longer than the hold', async () => {
    const leftAt = await host.nowIso();
    await publishers.at(-1)?.stop();

    await waitFor(
      async () => namesEveryRung(rungStreamsIn(await host.logsSince(uploader, leftAt), SRS_RUNG_UNPUBLISHED)),
      {
        timeoutMs: HOLD_RUNS_OUT_WAIT_MS,
        intervalMs: 3_000,
        label: 'every rung’s publish ends once the hold runs out, as `[SRS] Rung unpublished: <stream>`',
      },
    );
  });
});
