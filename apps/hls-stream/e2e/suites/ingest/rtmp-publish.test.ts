import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  everyStreamDelivered,
  printObservations,
  requirePublishing,
  secondsReading,
  secondsToFirstSegment,
  streamsPerBroadcast,
} from '../../src/harness/ingest.js';
import {
  isContiguous,
  manifestIndicesByStream,
  parseUploaderLog,
  segmentIndicesByStream,
  segmentUploads,
} from '../../src/harness/logwatch.js';
import { checkPublishedTimeline, publishingRungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';
import { INGEST_RTMP, unsupportedIngestReason } from '../../src/ingestProtocol.js';

/**
 * Ingest: a broadcast sent over RTMP publishes as one sent over SRT does, and the gateway serves the newest segment it
 * uploaded.
 *
 * Every other suite publishes over SRT unless the run sets `E2E_INGEST_PROTOCOL=rtmp`, so until RTMP became a public
 * ingest nothing sent RTMP through a real SRS. This is `service/happy-path` over RTMP, run in every full sitting. The
 * publisher dials the server and stream key a broadcaster is handed for OBS, and the broadcast has to upload gapless,
 * keep each stream's manifest advancing, publish playlists that hold to the manifest contract, and have the gateway
 * serve the newest segment the uploader published. The reasoning behind each of those checks is in
 * `service/happy-path`, which this follows.
 *
 * No browser opens this broadcast. Playback in a browser over RTMP comes from a browser run that also sets
 * `E2E_INGEST_PROTOCOL=rtmp`, where the viewer suites publish over RTMP like every suite that names no protocol.
 *
 * ⛔ Requires a deployed profile and a funded stamp, like every suite under `suites/`. Nothing in CI runs these.
 */

const TARGET_SEGMENTS = 6;
/** Two is the smallest number that tells "published once and froze" from "keeps re-publishing". */
const TARGET_MANIFESTS_PER_STREAM = 2;
const SEGMENT_WAIT_MS = 180_000;
const MANIFEST_WAIT_MS = 120_000;
/** The gateway retrieves a segment from the network rather than from the node that wrote it. */
const GATEWAY_FETCH_WAIT_MS = 120_000;
/** One segment is a few hundred kilobytes, and this bounds one attempt at it. */
const GATEWAY_FETCH_TIMEOUT_S = 30;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe(
  'ingest: an RTMP broadcast publishes gapless, and the gateway serves the newest segment it uploaded',
  { skip: unsupportedIngestReason(cfg.engine, INGEST_RTMP) ?? false },
  () => {
    const host = makeHost(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    const streams = streamsPerBroadcast(cfg);
    let publisher: Publisher;
    let startedAt: string;

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      startedAt = await host.nowIso();
      publisher = startPublisher(cfg, { protocol: INGEST_RTMP });
    });

    after(async () => {
      await publisher?.stop();
    });

    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

    it(`uploads ${TARGET_SEGMENTS} contiguous segments per stream, each stream’s manifest advancing`, async () => {
      await waitFor(
        async () => {
          requirePublishing(publisher, 'the RTMP publisher');
          return everyStreamDelivered(await log(), streams, TARGET_SEGMENTS);
        },
        {
          timeoutMs: SEGMENT_WAIT_MS,
          intervalMs: 2_000,
          label: `each of the ${streams} stream(s) uploads ${TARGET_SEGMENTS} segments from an RTMP publish`,
        },
      );

      const streamsShortOfManifests = async (): Promise<string[]> => {
        const text = await log();
        const published = manifestIndicesByStream(text);
        return [...segmentIndicesByStream(text).keys()].filter(
          (stream) => (published.get(stream) ?? []).length < TARGET_MANIFESTS_PER_STREAM,
        );
      };
      const shortAtStart = await streamsShortOfManifests();
      await waitFor(async () => (await streamsShortOfManifests()).length === 0, {
        timeoutMs: MANIFEST_WAIT_MS,
        intervalMs: 2_000,
        label:
          `every stream that uploaded publishes ${TARGET_MANIFESTS_PER_STREAM} manifests ` +
          `(short when this wait started: ${shortAtStart.join(', ') || 'none'})`,
      });

      // One read, and every verdict below comes out of it, for the reason `service/happy-path` gives.
      const text = await log();
      const segments = segmentIndicesByStream(text);
      const published = manifestIndicesByStream(text);

      assert.ok(
        segments.size >= streams,
        `${segments.size} stream(s) uploaded where the broadcast publishes ${streams}, so a verdict on contiguity ` +
          'would be printed over streams that never started',
      );
      for (const [stream, indices] of segments) {
        assert.ok(isContiguous(indices), `segment indices of ${stream} must be gapless; got: ${indices.join(',')}`);
      }
      const events = parseUploaderLog(text);
      assert.equal(
        events.discontinuitiesArmed,
        0,
        `nothing went wrong, so nothing should be announced as lost or broken; announced: ${events.discontinuitiesArmed}`,
      );
      for (const stream of segments.keys()) {
        const indices = published.get(stream) ?? [];
        assert.ok(
          indices.length >= TARGET_MANIFESTS_PER_STREAM && isContiguous(indices),
          `${stream} uploaded segments but its manifest did not keep advancing; SOC indices: ${indices.join(',') || 'none'}`,
        );
      }

      const firstAfterS = secondsToFirstSegment(text, startedAt);
      printObservations('rtmp-publish', [
        `from the RTMP publisher's start to its first segment uploaded: ${secondsReading(firstAfterS)}`,
      ]);
    });

    it('publishes playlists that hold to the manifest contract, and the gateway serves the newest segment', async () => {
      const { owner } = await discoverCatalogFeed(host, cfg);
      const verdict = await checkPublishedTimeline(host, cfg, {
        owner,
        rungs: publishingRungFeedsOf(await log()),
        expectation: cfg.segmentExpectation,
        logAfterTheRead: log,
      });

      console.log(verdict.summary);
      assert.equal(verdict.refusal, null, verdict.refusal ?? '');
      assert.equal(verdict.gapsSeen, 0, `a broadcast with no fault in it published ${verdict.gapsSeen} gap entry(s)`);

      const newest = segmentUploads(await log()).at(-1);
      assert.ok(newest, 'no segment upload in this window, so there is nothing for the gateway to serve');

      let answer = { status: 0, bytes: 0 };
      await waitFor(
        async () => {
          answer = await host.localStatus(
            cfg.ports.beeGatewayApi,
            `/bytes/${newest.reference}`,
            GATEWAY_FETCH_TIMEOUT_S,
          );
          return answer.status === 200 && answer.bytes > 0;
        },
        {
          timeoutMs: GATEWAY_FETCH_WAIT_MS,
          intervalMs: 3_000,
          label: `the gateway serves segment ${newest.index} of ${newest.streamId}, the newest the uploader published`,
        },
      );
      printObservations('rtmp-publish', [
        `segment ${newest.index} of ${newest.streamId} came back through the gateway, ${answer.bytes} bytes`,
      ]);
    });
  },
);
