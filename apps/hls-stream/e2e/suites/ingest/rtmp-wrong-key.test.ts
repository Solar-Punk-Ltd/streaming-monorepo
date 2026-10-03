import { derivePublishKey } from '@swarm-hls-stream/shared/publishKey';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { METRICS_PREFIX } from '../../src/harness/batchDrain.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  everyStreamDelivered,
  printObservations,
  publisherEnding,
  requirePublishing,
  streamsPerBroadcast,
} from '../../src/harness/ingest.js';
import { encoderReturnCount } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { counterOf, uploaderMetricsCommand } from '../../src/harness/uploaderMetrics.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { INGEST_RTMP, unsupportedIngestReason } from '../../src/ingestProtocol.js';

/**
 * Ingest: an RTMP publish presenting a wrong key is refused, and never takes a live broadcast over.
 *
 * RTMP carries the stream key in the clear and has no passphrase, so once the RTMP port is open the key is the whole
 * of what stands between a stranger and a stream. The key presented here is a real one, issued for another stream,
 * because that is the sharpest wrong key there is: it proves the uploader checks a key against the stream it names
 * rather than only whether it is one of ours.
 *
 * The second case is the one the takeover makes urgent. With RTMP's takeover on, a publisher the hook accepted
 * replaces a live one, so a hook that let a wrong key through would hand the broadcast to whoever sent it. The hook
 * refuses first and the takeover runs only after, so the live broadcast must carry on without a seam or a disconnect.
 *
 * Skipped where the stage checks no publish key, because there no key is wrong and any publisher is admitted.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in CI runs these.
 */

const AUTH_REJECTIONS_METRIC = `${METRICS_PREFIX}_auth_rejections_total`;
/** Whose key the wrong publisher presents: a stream that exists nowhere, under the deployment's own secret. */
const ANOTHER_STREAM = 'video/somebody-else';
const REFUSAL_WAIT_MS = 60_000;
const WARMUP_SEGMENTS = 3;
const AFTER_ATTEMPT_SEGMENTS = 4;
const SEGMENT_WAIT_MS = 180_000;
/**
 * How long the refused publisher is left trying before it is stopped, which is longer than SRS takes to refuse a
 * publish its hook turned away. A scenario input and not a reading.
 */
const REFUSED_PUBLISHER_GRACE_MS = 10_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

function skipReason(): string | false {
  const unsupported = unsupportedIngestReason(cfg.engine, INGEST_RTMP);
  if (unsupported !== null) {
    return unsupported;
  }
  return cfg.publishKeySecret === ''
    ? 'this stage checks no publish key, so no key is wrong and every publisher is admitted'
    : false;
}

describe(
  'ingest: an RTMP publish with a wrong key is refused, and never takes a live broadcast over',
  { skip: skipReason() },
  () => {
    const host = makeHost(cfg);
    const engine = getEngine(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    const streams = streamsPerBroadcast(cfg);
    const wrongKey = (): string => derivePublishKey(cfg.publishKeySecret, ANOTHER_STREAM);
    const publishers: Publisher[] = [];

    const authRejections = async (): Promise<number> => {
      const { stdout } = await host.run(uploaderMetricsCommand(uploader));
      const value = counterOf(stdout, AUTH_REJECTIONS_METRIC);
      if (value === null) {
        throw new Error(`the uploader's metrics carry no ${AUTH_REJECTIONS_METRIC}, so a refusal cannot be counted`);
      }
      return value;
    };

    const publish = (publishKey?: string): Publisher => {
      const publisher = startPublisher(cfg, { protocol: INGEST_RTMP, publishKey });
      publishers.push(publisher);
      return publisher;
    };

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
    });

    after(async () => {
      await Promise.all(publishers.map((publisher) => publisher.stop()));
    });

    it('refuses an RTMP publish presenting a key issued for another stream, and counts it', async () => {
      const startedAt = await host.nowIso();
      const rejectionsBefore = await authRejections();

      const wrong = publish(wrongKey());
      await waitFor(async () => (await authRejections()) > rejectionsBefore, {
        timeoutMs: REFUSAL_WAIT_MS,
        intervalMs: 2_000,
        label: 'the uploader counts the RTMP publish it refused for its key',
      });
      await sleep(REFUSED_PUBLISHER_GRACE_MS);

      const text = await host.logsSince(uploader, startedAt);
      assert.doesNotMatch(
        text,
        engine.publishedMarker,
        'the stream was published to with a key issued for another stream',
      );
      assert.equal((await uploaderHealth(host, cfg)).activeStreams, 0, 'and a session was started for it');

      printObservations('rtmp-wrong-key', [`the refused RTMP publisher ${publisherEnding(wrong)}`]);
      await wrong.stop();
    });

    it('leaves a live RTMP broadcast alone while a wrong key tries to take it over', async () => {
      const startedAt = await host.nowIso();
      const live = publish();
      await waitFor(
        async () => {
          requirePublishing(live, 'the live RTMP publisher');
          return everyStreamDelivered(await host.logsSince(uploader, startedAt), streams, WARMUP_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `each of the ${streams} stream(s) of the live broadcast uploads ${WARMUP_SEGMENTS} segments`,
        },
      );

      const attemptAt = await host.nowIso();
      const rejectionsBefore = await authRejections();
      const wrong = publish(wrongKey());
      await waitFor(async () => (await authRejections()) > rejectionsBefore, {
        timeoutMs: REFUSAL_WAIT_MS,
        intervalMs: 2_000,
        label: 'the uploader counts the wrong key that tried to take the live broadcast over',
      });
      await sleep(REFUSED_PUBLISHER_GRACE_MS);
      const wrongEnding = publisherEnding(wrong);
      await wrong.stop();

      await waitFor(
        async () => {
          requirePublishing(live, 'the live RTMP publisher, after a wrong key tried to take its stream over,');
          return everyStreamDelivered(await host.logsSince(uploader, attemptAt), streams, AFTER_ATTEMPT_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `the live broadcast keeps uploading on each of its ${streams} stream(s) after the wrong key was refused`,
        },
      );

      const sinceAttempt = await host.logsSince(uploader, attemptAt);
      assert.doesNotMatch(
        sinceAttempt,
        engine.unpublishedMarker,
        'the live broadcaster was disconnected by a wrong key',
      );
      assert.equal(encoderReturnCount(sinceAttempt), 0, 'a refused publish put a seam into the live broadcast');

      printObservations('rtmp-wrong-key', [`the RTMP publisher that tried to take the stream over ${wrongEnding}`]);
    });
  },
);
