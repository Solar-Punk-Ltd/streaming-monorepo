import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

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
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { fragmentSecondsFor } from '../../src/harness/manifestContractLive.js';
import {
  describeRecording,
  recordingRefusal,
  sessionGrowthRefusal,
  sessionsByRung,
} from '../../src/harness/recordingListing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';

/**
 * G2, admin mode: three broadcasts in a row on one declared stream.
 *
 * Two sessions can pass by luck of where the first one left its head. A third session reopens a feed whose head is a
 * recording that itself glued two sessions, so it shows whether the continuation compounds correctly: every session
 * publishes a moving live playlist on every rung, each rung resumes the topic at an SOC index strictly above the one
 * it resumed at the session before, the recording grows by exactly one session per later session on every rung, measured from the recording itself after
 * session 1 rather than from any log, and
 * the recovery entry a live session carries does not grow with every session glued onto the recording.
 *
 * ⛔ Admin mode only, with `E2E_ADMIN_API_URL`, `E2E_ADMIN_STREAM_ID` and `E2E_ADMIN_TOKEN`. Skips, printed as skipped,
 * without them. `admin/rebroadcast-vod` plays the recording this leaves behind.
 */

const SESSIONS = 3;
const SESSION_SECONDS = 90;
const PUBLISHES_PER_RUNG = 20;
const PUBLISH_WITHIN_MS = 60_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
/**
 * How much bigger the last session's recovery entry may be than the first's. An entry that carried every glued
 * session would be three times the first by the third session, and a bounded one stays about the same.
 */
const RECOVERY_ENTRY_GROWTH_LIMIT = 3;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const skip = adminSkipReason(admin, ['stream']);

/** The biggest recovery entry a session held while live, in bytes. */
function largestEntry(session: SessionRecord): number {
  return Math.max(0, ...session.recoveryEntryBytes.values());
}

describe('admin G2: three broadcasts in a row on one declared stream each continue every rung feed', { skip }, () => {
  const host = makeHost(cfg);
  let api: AdminApi;
  let declared: DeclaredStream;
  /** Sessions each rung's recording glued once session 1 finalized: the baseline the last session is measured from. */
  let afterFirst: ReadonlyMap<string, number> = new Map();
  const sessions: SessionRecord[] = [];

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    const mode = requireAdminMode(admin);
    api = new AdminApi(mode);
    declared = await prepareDeclaredStream(api, mode.streamId as string);
  });

  for (let n = 1; n <= SESSIONS; n++) {
    it(`publishes a moving live playlist on every rung in session ${n} of ${SESSIONS}`, async () => {
      assert.equal(sessions.length, n - 1, `session ${n - 1} did not run, so session ${n} has nothing to continue`);
      const session = await broadcastSession(host, cfg, api, {
        declared,
        seconds: SESSION_SECONDS,
        minPublishes: PUBLISHES_PER_RUNG,
        publishWithinMs: PUBLISH_WITHIN_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
      });
      sessions.push(session);
      console.log(session.playlists.summary);
      console.log(sessionObservations(session));
      assert.equal(session.playlists.refusal, null, session.playlists.refusal ?? '');
      if (n === 1) {
        afterFirst = sessionsByRung((await recordingAfter(host, cfg, declared, session)).rungs);
      }
    });
  }

  it('resumes every rung at a strictly higher SOC index in each later session', () => {
    assert.equal(sessions.length, SESSIONS, 'not every session ran');
    const resumedAt = sessions.map((session) => {
      const rungOf = new Map(announcedRungs(session.log).map((announce) => [announce.streamId, announce.rung]));
      return new Map(session.resumes.map((resume) => [rungOf.get(resume.streamId), resume.socIndex]));
    });
    for (const rung of cfg.abrRungs) {
      const indices = resumedAt.slice(1).map((byRung) => byRung.get(rung));
      console.log(`  ${rung} resumed at SOC index ${indices.join(' then ')}`);
      assert.ok(
        indices.every((index) => index !== undefined),
        `${rung} did not write a resume line in every later session, so some session numbered itself from nothing`,
      );
      const climbing = (indices as number[]).every((index, i, all) => i === 0 || index > all[i - 1]);
      assert.ok(climbing, `${rung} resumed at ${indices.join(', ')}, which does not climb session by session`);
      const first = resumedAt[0].get(rung);
      if (first !== undefined) {
        assert.ok((indices[0] as number) > first, `${rung} resumed session 2 at or below where session 1 resumed`);
      }
    }
  });

  it('keeps every session on every rung in the recording', async () => {
    const last = sessions.at(-1);
    assert.ok(last !== undefined, 'no session ran');
    const listing = await recordingAfter(host, cfg, declared, last);
    console.log(describeRecording(listing.offered, listing.rungs));
    const grew = sessionGrowthRefusal(afterFirst, sessionsByRung(listing.rungs), SESSIONS - 1);
    assert.equal(grew, null, grew ?? '');
    const refusal = recordingRefusal(listing.offered, listing.rungs, {
      rungs: cfg.abrRungs,
      sessions: new Map(cfg.abrRungs.map((rung) => [rung, (afterFirst.get(rung) ?? 0) + SESSIONS - 1])),
      fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
    });
    assert.equal(refusal, null, refusal ?? '');
  });

  it('does not grow the recovery entry by a session each time', () => {
    const first = largestEntry(sessions[0]);
    const last = largestEntry(sessions[SESSIONS - 1]);
    console.log(`  the largest recovery entry was ${first} bytes in session 1 and ${last} in session ${SESSIONS}`);
    assert.ok(first > 0, 'no recovery entry was read while session 1 was live, so there is nothing to compare');
    assert.ok(
      last < first * RECOVERY_ENTRY_GROWTH_LIMIT,
      `the recovery entry grew from ${first} to ${last} bytes over ${SESSIONS} sessions, so a live session is carrying ` +
        'every session glued onto its recording',
    );
  });
});
