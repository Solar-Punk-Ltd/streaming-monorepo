import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import {
  AdminApi,
  AdminRefusal,
  type AdminStream,
  adminModeFrom,
  adminSkipReason,
  requireAdminMode,
} from '../../src/harness/adminApi.js';
import {
  broadcastSession,
  type DeclaredStream,
  prepareDeclaredStream,
  type SessionRecord,
} from '../../src/harness/adminBroadcast.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { describeRecording, readRecordingListing } from '../../src/harness/recordingListing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';

/**
 * Admin mode: a recorded stream comes off the catalogue, goes back on as the same recording, and is deleted, and the
 * admin refuses every step out of order.
 *
 * The admin's own rules, read from `PublishService` and `StreamService`: a live stream cannot be unpublished, because
 * nothing in the admin can stop the encoder still pushing to it, and a stream can be deleted from draft only. So the
 * lifecycle is broadcast, stop, unpublish, which leaves the row a draft and the recording on its feeds, publish again,
 * which puts the entry back as a recording with the same final manifest index and duration, then unpublish and delete.
 *
 * ⛔ Declares a throwaway stream on the stage named in `E2E_ADMIN_STAGE_ID` and deletes it at the end, so no declared
 * stream anybody uses is touched. Skips, printed as skipped, without the admin settings and the stage id.
 */

const SESSION_SECONDS = 60;
const PUBLISHES_PER_RUNG = 10;
const PUBLISH_WITHIN_MS = 60_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const skip = adminSkipReason(admin, ['stage']);

/** The admin's error code for a refused call, or the error itself when it was not a refusal. */
async function refusalOf(call: Promise<unknown>): Promise<AdminRefusal> {
  const outcome = await call.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof AdminRefusal)) {
    throw new Error(
      `the admin was expected to refuse this call and ${outcome === null ? 'accepted it' : String(outcome)}`,
    );
  }
  return outcome;
}

describe(
  'admin: a recording leaves the catalogue, returns as itself, and is deleted, each step in order',
  { skip },
  () => {
    const host = makeHost(cfg);
    let api: AdminApi;
    let declared: DeclaredStream;
    let session: SessionRecord;
    let recorded: AdminStream;
    let deleted = false;

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      const mode = requireAdminMode(admin);
      api = new AdminApi(mode);
      const created = await api.createStream(
        `e2e catalog lifecycle ${new Date().toISOString()}`,
        mode.stageId as string,
      );
      declared = await prepareDeclaredStream(api, created.id);
    });

    after(async () => {
      if (deleted || declared === undefined) {
        return;
      }
      // Left behind only when a case failed part way. Taken off the catalogue and removed so the stage is not left
      // holding a stream named after a test, and a refusal here is printed rather than hiding the case's own failure.
      await api.unpublish(declared.stream.id).catch(() => undefined);
      await api
        .deleteStream(declared.stream.id)
        .catch((error) => console.error('could not remove the e2e stream:', error));
    });

    it('refuses to unpublish or delete the stream while it is live, and records it', async () => {
      session = await broadcastSession(host, cfg, api, {
        declared,
        seconds: SESSION_SECONDS,
        minPublishes: PUBLISHES_PER_RUNG,
        publishWithinMs: PUBLISH_WITHIN_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
        whileLive: async () => {
          assert.equal((await refusalOf(api.unpublish(declared.stream.id))).code, 'stream_live');
          assert.equal((await refusalOf(api.deleteStream(declared.stream.id))).code, 'stream_live');
        },
      });
      console.log(session.playlists.summary);
      assert.equal(session.playlists.refusal, null, session.playlists.refusal ?? '');
      recorded = await api.getStream(declared.stream.id);
      assert.equal(recorded.status, 'vod');
      assert.ok(recorded.manifestIndex != null, 'the finished stream carries no final manifest index');
    });

    it('refuses to delete a recording that is on the catalogue', async () => {
      assert.equal((await refusalOf(api.deleteStream(declared.stream.id))).code, 'stream_published');
    });

    it('takes the recording off the catalogue as a draft, and keeps the recording on its feeds', async () => {
      const unpublished = (await api.unpublish(declared.stream.id)).stream;
      assert.equal(unpublished.status, 'draft');
      assert.equal(unpublished.publishedFeedIndex, null, 'the row still names a catalogue index after leaving it');

      const listing = await readRecordingListing(host, cfg, {
        owner: declared.stream.owner,
        ladder: session.ladder,
        feeds: rungFeedsOf(session.log),
      });
      console.log(describeRecording(listing.offered, listing.rungs));
      const lost = listing.rungs.filter((rung) => !rung.recording).map((rung) => rung.rung);
      assert.deepEqual(lost, [], `unpublishing cost ${lost.join(', ')} its recording, which the feeds should keep`);
    });

    it('puts the same recording back on the catalogue when published again', async () => {
      const republished = (await api.publish(declared.stream.id)).stream;
      assert.equal(republished.status, 'vod', 'a republished recording came back as something other than a recording');
      assert.equal(
        republished.manifestIndex,
        recorded.manifestIndex,
        'the republished entry names another manifest index',
      );
      assert.equal(
        republished.durationSeconds,
        recorded.durationSeconds,
        'the republished entry names another duration',
      );
    });

    it('deletes the stream once it is a draft again, and only then', async () => {
      await api.unpublish(declared.stream.id);
      await api.deleteStream(declared.stream.id);
      deleted = true;
      assert.equal(
        (await refusalOf(api.getStream(declared.stream.id))).status,
        404,
        'the deleted stream still answers',
      );
    });
  },
);
