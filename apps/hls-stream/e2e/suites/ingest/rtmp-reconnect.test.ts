import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine, SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER } from '../../src/harness/engine.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  continuationRefusal,
  deliveredAfterReturn,
  everyStreamDelivered,
  printObservations,
  requirePublishing,
  secondsReading,
  secondsToFirstSeam,
  streamsPerBroadcast,
} from '../../src/harness/ingest.js';
import { announcedSessionTopics } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { readStageTakeovers } from '../../src/harness/stage.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { INGEST_RTMP, unsupportedIngestReason } from '../../src/ingestProtocol.js';
import { type TakeoverUnusable, takeoverUnusable } from '../../src/stageTakeover.js';

/**
 * Ingest: an RTMP broadcaster that drops and reconnects continues the same broadcast, whichever way it dropped.
 *
 * **A clean drop** closes the connection, SRS tells the uploader the broadcaster left, and the uploader holds the
 * session for its reconnect window. The reconnect arrives as an ordinary publish and joins that session.
 *
 * **An unclean drop** is an encoder whose network died without closing anything. SRS still holds its publish, so on
 * stock SRS the encoder's own reconnect is refused as busy until SRS gives up on the silent one, and an encoder that
 * gives up after one refusal ends the broadcast. The RTMP takeover is the answer: the reconnect, whose key the hook
 * accepted, replaces the silent publisher. The publisher here is frozen rather than stopped, which keeps its
 * connection open and silent, and its replacement starts a second later, well inside the time SRS would take to drop
 * the silent one on its own, so the reconnect is accepted only if the takeover took it.
 *
 * Both have to continue the broadcast they left: no new session, nothing finalized, and one seam per stream.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in CI runs these.
 */

const WARMUP_SEGMENTS = 3;
/**
 * Segments each stream uploads after its seam, every one of them the reconnect's, so the reconnect is shown carrying
 * the broadcast rather than landing a single segment.
 */
const RESUMED_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 180_000;
const DISCONNECT_WAIT_MS = 60_000;
const TAKEOVER_ORDER_WAIT_MS = 120_000;
/** When the broadcaster comes back after a clean drop: well inside the uploader's 60 second reconnect window. */
const RETURN_AFTER_CLEAN_DROP_MS = 3_000;
/**
 * When the broadcaster comes back after its network died: before SRS's own publish timeout would drop the silent
 * connection, 5 seconds by default and checked once a period, so only the takeover can let it in.
 */
const RETURN_AFTER_SILENCE_MS = 1_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const rtmpUnsupported = unsupportedIngestReason(cfg.engine, INGEST_RTMP) ?? false;

describe(
  'ingest: an RTMP broadcaster that drops cleanly and reconnects continues the same broadcast',
  { skip: rtmpUnsupported },
  () => {
    const host = makeHost(cfg);
    const engine = getEngine(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    const streams = streamsPerBroadcast(cfg);
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

    it('joins the session it left on reconnecting, with one seam per stream', async () => {
      const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
      const [first] = publishers;
      await waitFor(
        async () => {
          requirePublishing(first, 'the RTMP publisher');
          return everyStreamDelivered(await log(), streams, WARMUP_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `warmup: each of ${streams} stream(s) uploads ${WARMUP_SEGMENTS} segments`,
        },
      );
      const topicsBefore = new Set(announcedSessionTopics(await log()));
      assert.ok(
        topicsBefore.size > 0,
        'the broadcast announced no session before the drop, so there is nothing to rejoin',
      );

      const droppedAt = await host.nowIso();
      await first.stop();
      await waitFor(async () => engine.unpublishedMarker.test(await host.logsSince(uploader, droppedAt)), {
        timeoutMs: DISCONNECT_WAIT_MS,
        intervalMs: 1_000,
        label: 'the uploader is told the RTMP broadcaster left',
      });

      await sleep(RETURN_AFTER_CLEAN_DROP_MS);
      const returnedAt = await host.nowIso();
      const second = startPublisher(cfg, { protocol: INGEST_RTMP });
      publishers.push(second);

      await waitFor(
        async () => {
          requirePublishing(second, 'the reconnecting RTMP publisher');
          return deliveredAfterReturn(await host.logsSince(uploader, droppedAt), streams, RESUMED_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `each of ${streams} stream(s) places its seam and uploads ${RESUMED_SEGMENTS} segments after it`,
        },
      );

      const refusal = continuationRefusal(
        await log(),
        await host.logsSince(uploader, droppedAt),
        topicsBefore,
        streams,
      );
      assert.equal(refusal, null, refusal ?? '');

      const backAfterS = secondsToFirstSeam(await host.logsSince(uploader, returnedAt), returnedAt);
      printObservations('rtmp-reconnect, clean drop', [
        `from the reconnect to its first segment in the playlist: ${secondsReading(backAfterS)}`,
      ]);
    });
  },
);

describe(
  'ingest: an RTMP broadcaster whose network dies without closing takes its own stream back',
  { skip: rtmpUnsupported },
  () => {
    const host = makeHost(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    const streams = streamsPerBroadcast(cfg);
    const publishers: Publisher[] = [];
    let unusable: TakeoverUnusable | null = null;
    let startedAt: string;

    before(async () => {
      unusable = takeoverUnusable(INGEST_RTMP, await readStageTakeovers(host, cfg));
      if (unusable !== null) {
        return;
      }
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      startedAt = await host.nowIso();
      publishers.push(startPublisher(cfg, { protocol: INGEST_RTMP }));
    });

    after(async () => {
      await Promise.all(publishers.map((publisher) => publisher.stop()));
    });

    it('replaces the silent connection with the reconnect, and continues the same broadcast', async (t) => {
      if (unusable?.stale) {
        assert.fail(unusable.reason);
      }
      if (unusable !== null) {
        t.skip(unusable.reason);
        return;
      }
      const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
      const [silent] = publishers;
      await waitFor(
        async () => {
          requirePublishing(silent, 'the RTMP publisher');
          return everyStreamDelivered(await log(), streams, WARMUP_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `warmup: each of ${streams} stream(s) uploads ${WARMUP_SEGMENTS} segments`,
        },
      );
      const topicsBefore = new Set(announcedSessionTopics(await log()));
      assert.ok(
        topicsBefore.size > 0,
        'the broadcast announced no session before the drop, so there is nothing to rejoin',
      );

      const droppedAt = await host.nowIso();
      silent.freeze();
      await sleep(RETURN_AFTER_SILENCE_MS);
      const returnedAt = await host.nowIso();
      const returning = startPublisher(cfg, { protocol: INGEST_RTMP });
      publishers.push(returning);

      // A reconnect SRS refused as busy ends its own publisher, which stops this wait with what it said.
      await waitFor(
        async () => {
          requirePublishing(returning, 'the reconnecting RTMP publisher, refused while SRS still held the silent one,');
          return deliveredAfterReturn(await host.logsSince(uploader, droppedAt), streams, RESUMED_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `each of ${streams} stream(s) places its seam and uploads ${RESUMED_SEGMENTS} segments from the reconnect`,
        },
      );
      await waitFor(async () => SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER.test(await host.logsSince(uploader, droppedAt)), {
        timeoutMs: TAKEOVER_ORDER_WAIT_MS,
        intervalMs: 2_000,
        label: 'the silent connection leaves after the reconnect was accepted, which is the order a takeover makes',
      });

      const refusal = continuationRefusal(
        await log(),
        await host.logsSince(uploader, droppedAt),
        topicsBefore,
        streams,
      );
      assert.equal(refusal, null, refusal ?? '');
      assert.equal(returning.exit(), null, 'the reconnect is still the stream’s publisher');

      const backAfterS = secondsToFirstSeam(await host.logsSince(uploader, returnedAt), returnedAt);
      printObservations('rtmp-reconnect, unclean drop', [
        `from the reconnect to its first segment in the playlist: ${secondsReading(backAfterS)}`,
      ]);
    });
  },
);
