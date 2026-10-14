import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { loadConfig } from '../../src/config.js';
import { AdminApi, adminModeFrom, adminSkipReason, requireAdminMode } from '../../src/harness/adminApi.js';
import {
  broadcastSession,
  type DeclaredStream,
  prepareDeclaredStream,
  sessionObservations,
  recordingAfter,
  type SessionRecord,
} from '../../src/harness/adminBroadcast.js';
import { type BrowserArmResult, runBrowserArm } from '../../src/harness/browser.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { fragmentSecondsFor, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { describeMaster, masterRungRefusal, masterRungsOf, readLadderMaster } from '../../src/harness/masterShape.js';
import {
  describeRecording,
  recordingRefusal,
  sessionGrowthRefusal,
  sessionsByRung,
} from '../../src/harness/recordingListing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { pictureMovedRefusal } from '../../src/harness/vodArm.js';
import { viewerGate } from '../../src/viewerCoverage.js';

/**
 * G1, admin mode: the same declared stream broadcast twice, which is the 2026-10-14 defect exactly as it shipped.
 *
 * In admin mode every broadcast on a declared stream reuses its topic, so the second session opens over feeds whose
 * heads are the first session's recordings. On 2026-10-14 two or three of four rungs never published a live playlist
 * in the second session, while uploading segments the whole time.
 *
 * Each session broadcasts 90 s. In the second, every rung must publish 6 live playlists within 120 s of its first
 * segment, a floor rather than a rate, every rung head must move on the gateway, no playlist may be called stale, every rung must say it resumes
 * the declared topic at an SOC index above 0, and the master must offer all four. After the stop the recording lists
 * every rung with exactly one more session than it held after the first session finalized, the same count on every
 * rung. The baseline is read off the recording itself, because a declared stream's recording glues every session its
 * feed has ever carried, and a log tail forgets that history at the first redeploy.
 *
 * A viewer arm, when the run has a browser, watches across the gap: left on the ended overlay after the first session,
 * it must be taken back into the second without a fatal error and with a picture that moves.
 *
 * ⛔ Runs on a stage in admin mode only, with `E2E_ADMIN_API_URL`, `E2E_ADMIN_STREAM_ID` and `E2E_ADMIN_TOKEN` set.
 * Without them it skips, printed as skipped. See the e2e README for how the token reaches the shell that runs it.
 */

const SESSION_SECONDS = 90;
/**
 * Live playlists each rung must publish in a session, and how long it is given from its first segment. A floor that
 * says a rung publishes at all, set low and given room on purpose: an e2e suite checks correctness and never
 * throughput, and the count each rung actually reached is printed in the session summary.
 */
const PUBLISHES_PER_RUNG = 6;
const PUBLISH_WITHIN_MS = 120_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
/** The viewer arm watches the first session's end, the gap and the second session. */
const VIEWER_WATCH_MINUTES = 8;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const skip = adminSkipReason(admin, ['stream']);
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
const viewerSkip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe(
  'admin G1: a declared stream broadcast twice publishes a live playlist on every rung both times',
  { skip },
  () => {
    const host = makeHost(cfg);
    let api: AdminApi;
    let declared: DeclaredStream;
    /** Sessions each rung's recording glued once the first session finalized: the baseline the second grows from. */
    let afterFirst: ReadonlyMap<string, number> = new Map();
    const sessions: SessionRecord[] = [];
    let viewer: Promise<BrowserArmResult> | null = null;

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      const mode = requireAdminMode(admin);
      api = new AdminApi(mode);
      declared = await prepareDeclaredStream(api, mode.streamId as string);
    });

    after(async () => {
      await viewer?.catch(() => undefined);
    });

    const plan = () => ({
      declared,
      seconds: SESSION_SECONDS,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWithinMs: PUBLISH_WITHIN_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });

    it('publishes a moving live playlist on every rung in the first session', async () => {
      if (viewerSkip === false && backend !== null) {
        viewer = runBrowserArm(host, cfg, { backend, watchMinutes: VIEWER_WATCH_MINUTES });
      }
      sessions.push(await broadcastSession(host, cfg, api, plan()));
      console.log(sessions[0].playlists.summary);
      console.log(sessionObservations(sessions[0]));
      assert.equal(sessions[0].playlists.refusal, null, sessions[0].playlists.refusal ?? '');
      const baseline = await recordingAfter(host, cfg, declared, sessions[0]);
      console.log(describeRecording(baseline.offered, baseline.rungs));
      afterFirst = sessionsByRung(baseline.rungs);
    });

    it('publishes a moving live playlist on every rung again in the second session, continuing each feed', async () => {
      assert.equal(sessions.length, 1, 'the first session did not run, so there is nothing to broadcast again over');
      const second = await broadcastSession(host, cfg, api, plan());
      sessions.push(second);
      console.log(second.playlists.summary);
      console.log(sessionObservations(second));
      assert.equal(second.playlists.refusal, null, second.playlists.refusal ?? '');

      const rungOf = new Map(announcedRungs(second.log).map((announce) => [announce.streamId, announce.rung]));
      const resumedRungs = new Map(second.resumes.map((resume) => [rungOf.get(resume.streamId), resume]));
      for (const rung of cfg.abrRungs) {
        const resume = resumedRungs.get(rung);
        assert.ok(resume !== undefined, `${rung} reopened the declared topic and never read the head it continues`);
        assert.ok(
          resume.socIndex > 0,
          `${rung} resumed the declared topic at SOC index 0, over its own first recording`,
        );
      }
    });

    it('offers every rung in the master and records both sessions on every rung', async () => {
      const second = sessions[1];
      assert.ok(second !== undefined, 'the second session did not run');
      const feeds = rungFeedsOf(second.log);
      const owner = declared.stream.owner;
      if (second.ladder !== null) {
        const master = await readLadderMaster(host, cfg, owner, second.ladder);
        const read = masterRungsOf(master, new Map(feeds.map((feed) => [feed.topic, feed.rung ?? feed.topic])));
        console.log(`  ${describeMaster(read, master)}`);
        assert.equal(masterRungRefusal(read, cfg.abrRungs), null, masterRungRefusal(read, cfg.abrRungs) ?? '');
      }

      const listing = await recordingAfter(host, cfg, declared, second);
      console.log(describeRecording(listing.offered, listing.rungs));
      const grew = sessionGrowthRefusal(afterFirst, sessionsByRung(listing.rungs), 1, cfg.abrRungs);
      assert.equal(grew, null, grew ?? '');
      const refusal = recordingRefusal(listing.offered, listing.rungs, {
        rungs: cfg.abrRungs,
        sessions: new Map(cfg.abrRungs.map((rung) => [rung, (afterFirst.get(rung) ?? 0) + 1])),
        fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
      });
      assert.equal(refusal, null, refusal ?? '');
    });

    it('takes a viewer left on the ended overlay back into the second session', { skip: viewerSkip }, async () => {
      assert.ok(viewer !== null, 'no viewer arm was started with the first session');
      const result = await viewer;
      console.log(`  feed states the viewer met, in order: ${result.feedStatesSeen.join(', ')}`);
      assert.ok(result.reachedEndedOverlay, 'the viewer was never told the first session ended');
      assert.equal(
        result.fatalErrors,
        0,
        `the player hit ${result.fatalErrors} fatal error(s) across the re-broadcast`,
      );
      assert.equal(pictureMovedRefusal(result), null, pictureMovedRefusal(result) ?? '');
    });
  },
);
