import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER } from '../../src/harness/engine.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  continuationRefusal,
  deliveredAfterReturn,
  everyStreamDelivered,
  printObservations,
  publisherEnding,
  requirePublishing,
  secondsReading,
  secondsToFirstSeam,
  streamsPerBroadcast,
} from '../../src/harness/ingest.js';
import { announcedSessionTopics } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { readStageTakeovers } from '../../src/harness/stage.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { waitFor } from '../../src/harness/wait.js';
import {
  INGEST_RTMP,
  INGEST_SRT,
  type IngestProtocol,
  PROTOCOL_LABEL,
  unsupportedIngestReason,
} from '../../src/ingestProtocol.js';
import { type TakeoverUnusable, takeoverUnusable } from '../../src/stageTakeover.js';

/**
 * Ingest: a broadcaster moves from one protocol to the other in the middle of a broadcast, and it stays one broadcast.
 *
 * The broadcaster starts publishing over the second protocol while the first is still live, with the same key, which
 * is what an operator does to move an encoder from SRT to RTMP or back without ending the show. SRS handles it as a
 * takeover, and the takeover that decides is the one for the protocol the NEW publisher comes over: the connection it
 * replaces can be either. The old publisher is pushed off and ends, the new one publishes, and the uploader has to
 * read the old connection's late unpublish as the takeover it is rather than as the broadcaster leaving.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in CI runs these.
 */

const WARMUP_SEGMENTS = 3;
/**
 * Segments each stream uploads after its seam, every one of them the new publisher's, so the new publisher is shown
 * carrying the broadcast rather than landing a single segment.
 */
const RESUMED_SEGMENTS = 3;
const SEGMENT_WAIT_MS = 180_000;
const PUSHED_OFF_WAIT_MS = 60_000;
const TAKEOVER_ORDER_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const rtmpUnsupported = unsupportedIngestReason(cfg.engine, INGEST_RTMP) ?? false;

function describeSwitch(from: IngestProtocol, to: IngestProtocol): void {
  const [fromLabel, toLabel] = [PROTOCOL_LABEL[from], PROTOCOL_LABEL[to]];

  describe(
    `ingest: a broadcaster switching from ${fromLabel} to ${toLabel} mid-broadcast continues the same broadcast`,
    { skip: rtmpUnsupported },
    () => {
      const host = makeHost(cfg);
      const uploader = containerName(cfg, 'stream-uploader');
      const streams = streamsPerBroadcast(cfg);
      const publishers: Publisher[] = [];
      let unusable: TakeoverUnusable | null = null;
      let startedAt: string;

      before(async () => {
        unusable = takeoverUnusable(to, await readStageTakeovers(host, cfg));
        if (unusable !== null) {
          return;
        }
        await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
        await waitForIdle(host, cfg);
        startedAt = await host.nowIso();
        publishers.push(startPublisher(cfg, { protocol: from }));
      });

      after(async () => {
        await Promise.all(publishers.map((publisher) => publisher.stop()));
      });

      it(`takes the stream over from the live ${fromLabel} publisher with a ${toLabel} one`, async (t) => {
        if (unusable?.stale) {
          assert.fail(unusable.reason);
        }
        if (unusable !== null) {
          t.skip(unusable.reason);
          return;
        }
        const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
        const [old] = publishers;
        await waitFor(
          async () => {
            requirePublishing(old, `the ${fromLabel} publisher`);
            return everyStreamDelivered(await log(), streams, WARMUP_SEGMENTS);
          },
          {
            timeoutMs: SEGMENT_WAIT_MS,
            intervalMs: 2_000,
            label: `warmup: each of ${streams} stream(s) uploads ${WARMUP_SEGMENTS} segments over ${fromLabel}`,
          },
        );
        const topicsBefore = new Set(announcedSessionTopics(await log()));
        assert.ok(
          topicsBefore.size > 0,
          'the broadcast announced no session before the switch, so there is nothing to continue',
        );

        const switchedAt = await host.nowIso();
        const switchedAtMs = Date.now();
        const replacement = startPublisher(cfg, { protocol: to });
        publishers.push(replacement);

        await waitFor(async () => old.exit() !== null, {
          timeoutMs: PUSHED_OFF_WAIT_MS,
          intervalMs: 1_000,
          label: `SRS pushes the ${fromLabel} publisher off when the ${toLabel} one takes its stream over, so it ends`,
        });
        const pushedOffAfterS = (Date.now() - switchedAtMs) / 1_000;
        await waitFor(
          async () => {
            requirePublishing(replacement, `the ${toLabel} publisher that took the stream over`);
            return deliveredAfterReturn(await host.logsSince(uploader, switchedAt), streams, RESUMED_SEGMENTS);
          },
          {
            timeoutMs: SEGMENT_WAIT_MS,
            intervalMs: 2_000,
            label: `each of ${streams} stream(s) places its seam and uploads ${RESUMED_SEGMENTS} segments over ${toLabel}`,
          },
        );
        await waitFor(
          async () => SRS_OLD_CONNECTION_LEFT_AFTER_A_NEWER.test(await host.logsSince(uploader, switchedAt)),
          {
            timeoutMs: TAKEOVER_ORDER_WAIT_MS,
            intervalMs: 2_000,
            label: `the ${fromLabel} connection leaves after the ${toLabel} one was accepted, the order a takeover makes`,
          },
        );

        const refusal = continuationRefusal(
          await log(),
          await host.logsSince(uploader, switchedAt),
          topicsBefore,
          streams,
        );
        assert.equal(refusal, null, refusal ?? '');

        const firstAfterS = secondsToFirstSeam(await host.logsSince(uploader, switchedAt), switchedAt);
        printObservations(`protocol-switch, ${fromLabel} to ${toLabel}`, [
          `the ${fromLabel} publisher ended ${pushedOffAfterS.toFixed(0)}s after the ${toLabel} one started, read ` +
            `once a second, and ${publisherEnding(old)}`,
          `from the ${toLabel} publisher's start to its first segment in the playlist: ${secondsReading(firstAfterS)}`,
        ]);
      });
    },
  );
}

describeSwitch(INGEST_SRT, INGEST_RTMP);
describeSwitch(INGEST_RTMP, INGEST_SRT);
