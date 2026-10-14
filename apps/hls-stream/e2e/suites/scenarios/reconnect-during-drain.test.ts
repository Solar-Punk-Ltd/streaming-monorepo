import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { getEngine } from '../../src/harness/engine.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import {
  announcedRungs,
  announcedSessionTopics,
  announcedVodFinalizeCount,
  parseUploaderLog,
  sessionEnds,
} from '../../src/harness/logwatch.js';
import { fragmentSecondsFor, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { describeRecording, recordingRefusal, waitForRecordingListing } from '../../src/harness/recordingListing.js';
import {
  checkRungPlaylistsLive,
  missingTopicResumes,
  reapedAfterDisconnect,
  staleManifestWarnings,
} from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { recoveryEntryIds } from '../../src/harness/uploaderState.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { waitFor } from '../../src/harness/wait.js';

/**
 * Scenario K: a broadcaster reconnects while the previous session is still draining into its recording.
 *
 * ## Where the drain window is now
 *
 * Since the reconnect window of 2026-09-22 an SRS disconnect ends nothing: the session is held for `ORPHAN_REAP_MS`
 * (60 s) and an encoder back inside it resumes the same broadcast. A drain starts only when that window runs out, and
 * the uploader says so with `The encoder feeding X left and did not come back within the reconnect window`. So on SRS
 * the reconnect is made the moment that line appears, which lands it inside the drain. On OME the closing webhook still
 * stops the session directly, so its unpublish marker still opens the drain, as this scenario was first written.
 *
 * ## What must be true
 *
 * The outgoing session finalizes, the incoming one stays live and is not finalized with it, and the recovery entry
 * belongs to the session still running: an outgoing drain that cleared or overwrote it would leave a live broadcast
 * nothing on disk can recover.
 *
 * On a ladder the replacement reopens the same rung topics, because the group survives while any sibling is still
 * draining. Then each rung must read the head the drained session left, which is the `resumes its topic` line, publish
 * live playlists that move, and finish with a recording that glues both sessions. Whether the drain finished first and
 * released the group is the race this scenario cannot choose, so each rung is held to the case it actually took: a
 * reopened topic owes a resume line and two sessions in its recording, a fresh one owes neither.
 *
 * ⚠️ Stale warnings are printed and not refused. A replacement refuses its first playlist writes while the session it
 * replaced drains onto the same topic, and the uploader counts each refusal as a stale playlist on purpose.
 */

const WARMUP_SEGMENTS = 4;
const WARMUP_WAIT_MS = 120_000;
/** The disconnect, then the 60 s reconnect window, then the reap line. */
const DRAIN_START_WAIT_MS = 150_000;
const RECONNECT_WAIT_MS = 120_000;
const VOD_WAIT_MS = 300_000;
const PUBLISHES_PER_RUNG = 10;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const RECORDING_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

describe('K — reconnect during drain: the live session keeps its playlists and its recovery entry', () => {
  const engine = getEngine(cfg);
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let first: Publisher | undefined;
  let second: Publisher | undefined;
  let startedAt: string;
  let reconnectedAt: string | undefined;
  let beforeReconnect = '';

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
  /** The line that says the outgoing session has started to drain, by engine. */
  const drainStarted = (text: string): boolean =>
    cfg.engine === 'srs' ? reapedAfterDisconnect(text).length > 0 : engine.unpublishedMarker.test(text);

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    first = startPublisher(cfg);
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
  });

  it('keeps the reconnected session live, publishing, and owning its recovery entry', async () => {
    await waitFor(async () => parseUploaderLog(await log()).uploadedSegments.length >= WARMUP_SEGMENTS, {
      timeoutMs: WARMUP_WAIT_MS,
      intervalMs: 2_000,
      label: `warmup: ${WARMUP_SEGMENTS} segments before the disconnect`,
    });
    assert.ok(announcedSessionTopics(await log()).length > 0, 'the first session never announced a topic');

    const stoppedAt = await host.nowIso();
    await first?.stop();
    first = undefined;
    // Polled tight, because everything after this line is the drain window the reconnect has to land inside.
    await waitFor(async () => drainStarted(await host.logsSince(uploader, stoppedAt)), {
      timeoutMs: DRAIN_START_WAIT_MS,
      intervalMs: 250,
      label: 'the outgoing session starts to drain into its recording',
    });
    reconnectedAt = await host.nowIso();
    beforeReconnect = await host.logsBetween(uploader, startedAt, reconnectedAt);
    second = startPublisher(cfg);
    const sinceReconnect = async (): Promise<string> => host.logsSince(uploader, reconnectedAt as string);

    await waitFor(async () => announcedSessionTopics(await sinceReconnect()).length > 0, {
      timeoutMs: RECONNECT_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnecting broadcaster is registered as a session of its own',
    });

    const outgoingRungs = cfg.abrEnabled ? cfg.abrRungs.length : 1;
    await waitFor(async () => new Set(sessionEnds(await log())).size >= outgoingRungs, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'every rung of the drained session finalizes',
    });

    const playlists = await checkRungPlaylistsLive(host, cfg, {
      log: sinceReconnect,
      rungs: cfg.abrEnabled ? cfg.abrRungs : null,
      namesFrom: beforeReconnect,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWaitMs: VOD_WAIT_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
      refuseStale: false,
    });
    console.log(playlists.summary);
    assert.equal(playlists.refusal, null, playlists.refusal ?? '');

    const reconnected = await sinceReconnect();
    const unresumed = missingTopicResumes(beforeReconnect, reconnected);
    assert.deepEqual(
      unresumed,
      [],
      `${unresumed.join(', ')} reopened the topic its drained session held and never read the head it left`,
    );
    const earlierTopics = new Set(announcedRungs(beforeReconnect).map((line) => line.topic));
    const reopened = announcedRungs(reconnected).filter((line) => earlierTopics.has(line.topic));
    console.log(
      `  observations, none of them asserted. ${reopened.length} rung(s) reopened their drained topic, and the ` +
        `reconnected session wrote ${staleManifestWarnings(reconnected).length} stale warning(s) while the drain finished`,
    );

    const health = await uploaderHealth(host, cfg);
    assert.ok(
      health.activeStreams >= 1,
      `the reconnected broadcast is not live; activeStreams=${health.activeStreams}`,
    );
    const entries = await recoveryEntryIds(host, cfg);
    assert.ok(
      entries.length > 0,
      'the live session holds no recovery entry after the previous session drained, so a crash from here loses it',
    );
  });

  it('finalizes the reconnected session into a recording that glues every session its topics carried', async () => {
    assert.ok(reconnectedAt !== undefined, 'the reconnect case never reconnected, so there is nothing to finalize');
    const reconnected = await host.logsSince(uploader, reconnectedAt);
    const feeds = rungFeedsOf(reconnected);
    const ladder = announcedRungs(reconnected)[0]?.ladder ?? null;
    const flipsBefore = announcedVodFinalizeCount(await log());
    await second?.stop();
    second = undefined;

    await waitFor(async () => announcedVodFinalizeCount(await log()) > flipsBefore, {
      timeoutMs: VOD_WAIT_MS,
      intervalMs: 2_000,
      label: 'the reconnected session finalizes into a recording of its own',
    });

    const earlierTopics = new Set(announcedRungs(beforeReconnect).map((line) => line.topic));
    const sessions = new Map(feeds.map((feed) => [feed.rung ?? feed.topic, earlierTopics.has(feed.topic) ? 2 : 1]));
    const { owner } = await discoverCatalogFeed(host, cfg);
    const listing = await waitForRecordingListing(host, cfg, { owner, ladder, feeds }, RECORDING_WAIT_MS);
    console.log(describeRecording(listing.offered, listing.rungs));
    const refusal = recordingRefusal(listing.offered, listing.rungs, {
      rungs: [...sessions.keys()],
      sessions,
      fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
      // A rung that took the fresh-topic path recorded only the reconnected session, so it is right to be shorter than
      // a sibling whose recording glued the drained session in front.
      shortOnPurpose: [...sessions]
        .filter(([, count]) => count === 1 && [...sessions.values()].includes(2))
        .map(([rung]) => rung),
    });
    assert.equal(refusal, null, refusal ?? '');
  });
});
