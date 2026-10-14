import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import { AdminApi, adminModeFrom, adminSkipReason, requireAdminMode } from '../../src/harness/adminApi.js';
import {
  broadcastSession,
  type DeclaredStream,
  declaredRungFeeds,
  prepareDeclaredStream,
  sessionObservations,
} from '../../src/harness/adminBroadcast.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { fragmentSecondsFor, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import {
  describeRecording,
  type RecordingListing,
  readRecordingListing,
  recordingRefusal,
  waitForRecordingListing,
} from '../../src/harness/recordingListing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';

/**
 * G3, admin mode: a declared stream broadcast again after the postage batch its first session spent has expired.
 *
 * The second session reopens each rung's topic and reads the feed head, which is a recording whose chunks were paid
 * for by a batch that no longer exists. Whatever that read can or cannot return, the new session must still publish a
 * live playlist on every rung that moves, write no stale warning, and finish with a recording on every rung. How many
 * sessions that recording should glue when the earlier media is gone is a product rule nobody has set, so it is
 * printed and not asserted.
 *
 * ⛔ Needs a stage fixture nothing in a suite can make: a declared stream, named in `E2E_ADMIN_EXPIRED_STREAM_ID`,
 * whose earlier session's batch has expired. Bee refuses a batch that lives under 24 hours, so the fixture is a stream
 * broadcast on a short-lived batch at least a day before the run. Skips, printed as skipped, without the setting. The
 * first case checks the fixture is what it says it is, and the rest skip loudly when it is not.
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
const RECORDING_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const skip = adminSkipReason(admin, ['expired']);

describe('admin G3: a declared stream broadcast again after its first batch expired', { skip }, () => {
  const host = makeHost(cfg);
  let api: AdminApi;
  let declared: DeclaredStream;
  let earlier: RecordingListing;
  let fixtureHolds = false;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    const mode = requireAdminMode(admin);
    api = new AdminApi(mode);
    declared = await prepareDeclaredStream(api, mode.expiredStreamId as string);
    const feeds = await declaredRungFeeds(host, cfg, api, declared);
    earlier = await readRecordingListing(host, cfg, { owner: declared.stream.owner, ladder: null, feeds });
  });

  it('is a declared stream whose earlier recording can no longer be read', () => {
    console.log(describeRecording(earlier.offered, earlier.rungs));
    assert.ok(
      earlier.rungs.length > 0,
      'the catalogue entry names no rung of an earlier broadcast, so it is no fixture',
    );
    const readable = earlier.rungs.filter((rung) => rung.recording);
    fixtureHolds = readable.length === 0;
    assert.equal(
      readable.length,
      0,
      `${readable.map((rung) => rung.rung).join(', ')} still serve their earlier recording, so the batch behind them ` +
        'has not expired and this stream is not the fixture E2E_ADMIN_EXPIRED_STREAM_ID promises',
    );
  });

  it('publishes a moving live playlist on every rung over the expired feed', async (t) => {
    if (!fixtureHolds) {
      t.skip('SKIPPED, NOT PASSED: the fixture check above failed, so this broadcast would not ask its question');
      return;
    }
    const session = await broadcastSession(host, cfg, api, {
      declared,
      seconds: SESSION_SECONDS,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWithinMs: PUBLISH_WITHIN_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });
    console.log(session.playlists.summary);
    console.log(sessionObservations(session));
    assert.equal(session.playlists.refusal, null, session.playlists.refusal ?? '');

    const listing = await waitForRecordingListing(
      host,
      cfg,
      { owner: declared.stream.owner, ladder: session.ladder, feeds: rungFeedsOf(session.log) },
      RECORDING_WAIT_MS,
    );
    console.log(describeRecording(listing.offered, listing.rungs));
    console.log(
      `  observations, none of them asserted. sessions glued per rung: ${listing.rungs
        .map((rung) => `${rung.rung} ${rung.sessions}`)
        .join(', ')}`,
    );
    const finished = listing.rungs.map((rung) => ({ ...rung, sessions: 1 }));
    const refusal = recordingRefusal(listing.offered, finished, {
      rungs: cfg.abrRungs,
      sessions: 1,
      fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
    });
    assert.equal(refusal, null, refusal ?? '');
  });
});
