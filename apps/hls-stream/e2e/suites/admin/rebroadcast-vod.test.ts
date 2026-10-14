import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { loadConfig } from '../../src/config.js';
import { AdminApi, adminModeFrom, adminSkipReason, requireAdminMode } from '../../src/harness/adminApi.js';
import { type DeclaredStream, declaredRungFeeds, prepareDeclaredStream } from '../../src/harness/adminBroadcast.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { makeHost } from '../../src/harness/host.js';
import { fragmentSecondsFor } from '../../src/harness/manifestContractLive.js';
import { describeRecording, type RecordingListing, readRecordingListing } from '../../src/harness/recordingListing.js';
import {
  finishedTimelineRefusal,
  pictureMovedRefusal,
  playedBackRefusal,
  vodArmRefusal,
  vodArmSummary,
  wholeLadderRefusal,
} from '../../src/harness/vodArm.js';
import { viewerGate } from '../../src/viewerCoverage.js';

/**
 * G17, admin mode: the recording a declared stream glued from several sessions plays as one broadcast.
 *
 * A recording on a declared stream carries every session its feed has carried, joined at a discontinuity per seam.
 * A player has to cross each seam without stopping, offer the whole ladder, and play as long as the longest rung's
 * recording is. Played through the shipped client by `browser:vod`, which seeks around inside the recording.
 *
 * ⛔ Reads the recording an earlier broadcast left. Run after `admin/rebroadcast-three-times`, which `pnpm e2e:admin`
 * does because the files sort that way. A recording with fewer than two sessions on any rung refuses, because there
 * is no seam to cross and this would pass without asking its question.
 *
 * ⛔ Admin mode and a browser only. Skips, printed as skipped, without the admin settings or without
 * `E2E_EXPECT_BROWSER=true`.
 */

const WATCH_MINUTES = 4;
const MIN_SESSIONS = 2;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
const skip = adminSkipReason(admin, ['stream']) || viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe('admin G17: a recording glued from several sessions plays across every seam', { skip }, () => {
  const host = makeHost(cfg);
  let declared: DeclaredStream;
  let listing: RecordingListing;

  before(async () => {
    const mode = requireAdminMode(admin);
    declared = await prepareDeclaredStream(new AdminApi(mode), mode.streamId as string);
    const feeds = await declaredRungFeeds(host, cfg, declared);
    listing = await readRecordingListing(host, cfg, { owner: declared.stream.owner, ladder: null, feeds });
  });

  it('holds a recording on every rung with a seam to cross', () => {
    console.log(describeRecording(listing.offered, listing.rungs));
    for (const rung of cfg.abrRungs) {
      const recorded = listing.rungs.find((candidate) => candidate.rung === rung);
      assert.ok(recorded?.recording, `${rung} of the declared stream holds no recording to play`);
      assert.ok(
        recorded.sessions >= MIN_SESSIONS,
        `${rung}'s recording glues ${recorded.sessions} session(s), so there is no seam to cross. Run ` +
          'admin/rebroadcast-three-times first',
      );
    }
  });

  it('plays the whole ladder, finished, for as long as the longest rung recorded', async () => {
    const result = await runBrowserArm(host, cfg, {
      backend: backend as NonNullable<typeof backend>,
      watchMinutes: WATCH_MINUTES,
      vod: { owner: declared.stream.owner, topic: declared.stream.topic },
    });
    console.log(`  ${vodArmSummary(result)}`);
    assert.equal(vodArmRefusal(result), null, vodArmRefusal(result) ?? '');
    const vod = result.vod;
    assert.ok(vod, 'the refusal above should already have caught an arm with no playback verdict');
    assert.equal(playedBackRefusal(vod), null, playedBackRefusal(vod) ?? '');
    assert.equal(finishedTimelineRefusal(vod), null, finishedTimelineRefusal(vod) ?? '');
    const heights = cfg.abrLadder.map((rung) => rung.height);
    assert.equal(wholeLadderRefusal(vod, heights), null, wholeLadderRefusal(vod, heights) ?? '');
    assert.equal(pictureMovedRefusal(result), null, pictureMovedRefusal(result) ?? '');

    const longest = Math.max(...listing.rungs.map((rung) => rung.durationSeconds));
    const fragment = fragmentSecondsFor(cfg.segmentExpectation) ?? 2;
    assert.ok(
      vod.durationS !== null && longest - vod.durationS <= fragment,
      `the player reports ${vod.durationS ?? 'no'} seconds of a recording whose longest rung holds ` +
        `${longest.toFixed(1)}s, so it stopped at a seam rather than playing every session`,
    );
  });
});
