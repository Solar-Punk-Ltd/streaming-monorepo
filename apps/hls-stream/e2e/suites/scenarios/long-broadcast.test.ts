import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs, announcedSessionTopics, vodFinalizeCountFor } from '../../src/harness/logwatch.js';
import { finalizeSecondsAfterLastPublish, longBroadcastMinutes } from '../../src/harness/longBroadcast.js';
import { fragmentSecondsFor, publishedCountsOf, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { vodFinalizeWaitMs } from '../../src/harness/recording.js';
import {
  describeRecording,
  type RecordingListing,
  recordingRefusal,
  uploadsPerRecordingRung,
  waitForRecordingListing,
} from '../../src/harness/recordingListing.js';
import { checkRungPlaylistsLive } from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { type CatalogFeed, discoverCatalogFeed, entryCarriesTopic, fetchCatalog } from '../../src/harness/viewer.js';
import {
  finishedTimelineRefusal,
  pictureMovedRefusal,
  playedBackRefusal,
  vodArmRefusal,
  vodArmSummary,
  wholeLadderRefusal,
} from '../../src/harness/vodArm.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { viewerGate } from '../../src/viewerCoverage.js';

/**
 * G10: one long broadcast, whose recording outgrows a single Swarm chunk many times over, finalizes whole.
 *
 * A recording playlist names every segment the broadcast made. At 1 s segments a four-rung recording passes the 4096
 * bytes a chunk holds in about two minutes, and every other suite stops long before a recording is that big. This one
 * broadcasts `E2E_LONG_BROADCAST_MINUTES` (20 by default), stops, and asserts the finalize succeeds, the catalog entry
 * flips to `vod`, the recording lists every rung with every segment that rung uploaded, and, when the run has a
 * browser, the shipped client plays it.
 *
 * How long the finish took, from the last live playlist to the ladder's VOD flip, is printed as an observation and
 * never asserted: owner rule, an e2e suite checks correctness and never timing.
 *
 * ⛔ A paid broadcast of twenty minutes on every rung. Size it with the setting, never by editing this file.
 */

const MINUTES = longBroadcastMinutes(process.env);
const PUBLISHES_PER_RUNG = 10;
const PUBLISH_WAIT_MS = 180_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const CATALOG_WAIT_MS = 300_000;
const RECORDING_WAIT_MS = 300_000;
const WATCH_MINUTES = 4;
const MIN_STAMP_TTL_S = 3_600;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
const viewerSkip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe(`G10: a ${MINUTES} minute broadcast finalizes into a whole recording on every rung`, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const rungs = cfg.abrEnabled ? cfg.abrRungs : null;
  let publisher: Publisher | undefined;
  let feed: CatalogFeed;
  let startedAt: string;
  let listing: RecordingListing | undefined;
  let entry: { owner: string; topic: string } | undefined;

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    feed = await discoverCatalogFeed(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('keeps every rung publishing a moving live playlist for the whole broadcast', async () => {
    const opening = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWaitMs: PUBLISH_WAIT_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });
    assert.equal(opening.refusal, null, `the broadcast was not healthy at its start: ${opening.refusal ?? ''}`);

    await sleep(Math.max(0, MINUTES * 60_000 - (Date.now() - Date.parse(startedAt))));

    const closing = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWaitMs: 0,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });
    console.log(closing.summary);
    assert.equal(closing.refusal, null, closing.refusal ?? '');
  });

  it('finalizes, flips the catalog to vod, and records every segment of every rung', async () => {
    await publisher?.stop();
    publisher = undefined;
    const text = await log();
    const topics = announcedSessionTopics(text);
    const ladder = announcedRungs(text)[0]?.ladder ?? null;

    await waitFor(async () => vodFinalizeCountFor(await log(), topics) >= 1, {
      timeoutMs: vodFinalizeWaitMs({ segmentSeconds: fragmentSecondsFor(cfg.segmentExpectation), pollMs: 3_000 }),
      intervalMs: 3_000,
      label: 'the long broadcast finalizes to VOD after the stop',
    });
    const finished = await log();
    const finalizeS = ladder === null ? null : finalizeSecondsAfterLastPublish(finished, ladder);
    console.log(
      `  observations, none of them asserted. the ladder flipped to VOD ${finalizeS?.toFixed(1) ?? 'an unknown number of'}s ` +
        'after the last live playlist any rung published',
    );

    const ours = new Set(topics);
    await waitFor(
      async () => {
        const found = (await fetchCatalog(host, cfg, feed).catch(() => [])).find(
          (candidate) => entryCarriesTopic(candidate, ours) && candidate.state === 'vod',
        );
        entry = found === undefined ? undefined : { owner: found.owner, topic: found.topic };
        return found !== undefined;
      },
      { timeoutMs: CATALOG_WAIT_MS, intervalMs: 5_000, label: 'the long recording reaches the catalog as vod' },
    );

    listing = await waitForRecordingListing(
      host,
      cfg,
      { owner: feed.owner, ladder, feeds: rungFeedsOf(finished) },
      RECORDING_WAIT_MS,
    );
    console.log(describeRecording(listing.offered, listing.rungs));
    const expected = rungs ?? listing.rungs.map((rung) => rung.rung);
    const refusal = recordingRefusal(listing.offered, listing.rungs, {
      rungs: expected,
      sessions: 1,
      fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
    });
    assert.equal(refusal, null, refusal ?? '');

    const uploads = uploadsPerRecordingRung(rungFeedsOf(finished), publishedCountsOf(finished));
    for (const rung of listing.rungs) {
      const uploaded = uploads.get(rung.rung);
      assert.ok(
        uploaded !== undefined && uploaded !== null,
        `${rung.rung}'s uploads could not be attributed to its recording, so whether it kept them was not judged`,
      );
      assert.ok(
        rung.segments >= uploaded,
        `${rung.rung}'s recording names ${rung.segments} segment(s) of the ${uploaded} it uploaded, so the recording ` +
          'lost media once it outgrew a chunk',
      );
    }
  });

  it('plays the long recording in the shipped client', { skip: viewerSkip }, async () => {
    assert.ok(entry !== undefined, 'the recording never reached the catalog, so there is nothing to play');
    const result = await runBrowserArm(host, cfg, {
      backend: backend as NonNullable<typeof backend>,
      watchMinutes: WATCH_MINUTES,
      vod: entry,
    });
    console.log(`  ${vodArmSummary(result)}`);
    assert.equal(vodArmRefusal(result), null, vodArmRefusal(result) ?? '');
    const vod = result.vod;
    assert.ok(vod, 'the refusal above should already have caught an arm with no playback verdict');
    assert.equal(playedBackRefusal(vod), null, playedBackRefusal(vod) ?? '');
    assert.equal(finishedTimelineRefusal(vod), null, finishedTimelineRefusal(vod) ?? '');
    if (cfg.abrEnabled) {
      const heights = cfg.abrLadder.map((rung) => rung.height);
      assert.equal(wholeLadderRefusal(vod, heights), null, wholeLadderRefusal(vod, heights) ?? '');
    }
    assert.equal(pictureMovedRefusal(result), null, pictureMovedRefusal(result) ?? '');
  });
});
