import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  listProcessesCommand,
  type RungProcess,
  rungProcesses,
  SIGNAL_QUIET,
  SIGNAL_RESUME,
  signalCommand,
} from '../../src/browser/rungTranscode.js';
import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import {
  announcedRungs,
  announcedSessionTopics,
  sessionEnds,
  vodFinalizeCountFor,
} from '../../src/harness/logwatch.js';
import { fragmentSecondsFor, readOneRungPlaylist, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { waitForMasterRungs } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { COORDINATOR_RUNG } from '../../src/harness/publishers.js';
import { describeRecording, recordingRefusal, waitForRecordingListing } from '../../src/harness/recordingListing.js';
import { vodFinalizeWaitMs } from '../../src/harness/recording.js';
import {
  checkRungPlaylistsLive,
  manifestIndicesByRung,
  readFeedIndex,
  staleManifestWarnings,
  staleWarningRefusal,
  topicResumes,
} from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Scenario: one rung's transcode stops long enough for its session to be finalized, then comes back on the same topic.
 *
 * ## ⛔ Why this is the regression test for 2026-10-14
 *
 * On 2026-10-14 a re-broadcast on one declared stream left two or three of four rungs with no live playlist. A session
 * that reopens a topic an earlier session wrote has to read that feed's head first and continue above it, and that read
 * is what failed. Admin mode reuses its topic on every broadcast, but every standalone suite mints a fresh ladder group
 * per broadcast and so never reopens a topic, and the two crash suites rebuild their sessions from a recovery entry,
 * which skips the read on purpose. This fault is the one standalone path that runs it.
 *
 * The transcode of one rung is frozen with SIGSTOP. Its rung stops posting segments, the orphan reaper finalizes that
 * rung's session after `ORPHAN_REAP_MS` (60 s) of no media, and its recording lands on the rung's feed. The siblings keep
 * the ladder group alive, so when the transcode is resumed the rung announces again on the very same topic, over a feed
 * whose head is that recording. It must then say it resumes its topic at exactly the index the gateway resolves that
 * head at, and publish above it.
 *
 * ## What it asserts
 *
 * 1. While the rung is silent the master stops offering it, and after it returns and publishes 8 playlists the master
 *    offers it again.
 * 2. The returning rung writes `resumes its topic at SOC index N` with N the recording's index read off the gateway
 *    before the resume, and every live playlist it publishes afterwards is above N, numbered from a media sequence that
 *    continues rather than restarting at 0.
 * 3. No live playlist is called stale across the whole broadcast, and the three siblings keep publishing moving
 *    playlists throughout.
 * 4. After the stop the recording lists every rung, with two sessions on the restarted rung and one on the others.
 *
 * ⛔ Requires SRS and a ladder. The transcode is a process in the SRS container, which OME does not have, and the
 * coordinator rung is never the one silenced, because it writes the catalog and the master for all four.
 */

/** How long the transcode is held frozen: past the 60 s reap, with room for the finalize to land. */
const SILENCE_MS = 90_000;
const WARMUP_PUBLISHES = 8;
/** Clean playlists the returning rung publishes before the master must offer it again. */
const RETURN_PUBLISHES = 8;
const WARMUP_WAIT_MS = 180_000;
const SESSION_END_WAIT_MS = 180_000;
const RETURN_WAIT_MS = 180_000;
const MASTER_WAIT_MS = 180_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const RECORDING_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

/** The rung silenced: the tallest one that is not the coordinator. */
const silencedRung = cfg.abrRungs.filter((rung) => rung !== COORDINATOR_RUNG).at(-1) ?? null;

function skipReason(): string | false {
  if (!cfg.abrEnabled) {
    return 'ABR_ENABLED is off on this deployment, so there is no ladder to keep alive around a restarted rung';
  }
  if (cfg.engine !== 'srs') {
    return `the rung transcodes run inside SRS and this deployment runs ${cfg.engine}`;
  }
  return silencedRung === null ? 'the ladder has no rung besides the coordinator to silence' : false;
}

describe(
  'rung restart: a rung reopens its own topic and continues the feed it finalized',
  { skip: skipReason() },
  () => {
    const host = makeHost(cfg);
    const uploader = containerName(cfg, 'stream-uploader');
    const engine = containerName(cfg, cfg.engine);
    const rung = silencedRung as string;
    const siblings = cfg.abrRungs.filter((name) => name !== rung);
    let publisher: Publisher | undefined;
    let startedAt: string;
    let transcodes: readonly RungProcess[] = [];

    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const resume = async (): Promise<void> => {
      if (transcodes.length === 0) {
        return;
      }
      const pids = transcodes.map((process) => process.pid);
      transcodes = [];
      await host.run(signalCommand(engine, pids, SIGNAL_RESUME));
    };

    before(async () => {
      await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
      await waitForIdle(host, cfg);
      startedAt = await host.nowIso();
      publisher = startPublisher(cfg);
    });

    after(async () => {
      // ⛔ A frozen transcode left behind holds this rung quiet on every later broadcast, and nothing would report it.
      await resume().catch((error) => console.error('could not resume the frozen transcode:', error));
      await publisher?.stop();
    });

    it('drops the silent rung from the master, then takes it back at the index its recording holds', async () => {
      const warm = await checkRungPlaylistsLive(host, cfg, {
        log,
        rungs: cfg.abrRungs,
        minPublishes: WARMUP_PUBLISHES,
        publishWaitMs: WARMUP_WAIT_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
      });
      console.log(warm.summary);
      assert.equal(warm.refusal, null, `the ladder was not healthy before the fault: ${warm.refusal ?? ''}`);

      const beforeFault = await log();
      const announce = announcedRungs(beforeFault).find((line) => line.rung === rung);
      assert.ok(announce !== undefined, `${rung} never announced, so there is no topic for it to reopen`);
      const { owner } = await discoverCatalogFeed(host, cfg);
      const topicsOf = async (): Promise<ReadonlyMap<string, string>> =>
        new Map(announcedRungs(await log()).map((line) => [line.topic, line.rung]));

      transcodes = rungProcesses((await host.run(listProcessesCommand(engine))).stdout, rung);
      assert.ok(transcodes.length > 0, `no transcode in ${engine} produces ${rung}, so this run would silence nothing`);
      const quietAt = await host.nowIso();
      await host.run(
        signalCommand(
          engine,
          transcodes.map((process) => process.pid),
          SIGNAL_QUIET,
        ),
      );
      console.log(`  froze ${rung}'s transcode for ${SILENCE_MS / 1000}s`);

      await waitForMasterRungs(host, cfg, {
        owner,
        ladder: announce.ladder,
        expected: siblings,
        readTopics: topicsOf,
        timeoutMs: MASTER_WAIT_MS,
        label: `the master stops offering ${rung} while it is silent`,
      });
      await waitFor(async () => sessionEnds(await host.logsSince(uploader, quietAt)).includes(announce.streamId), {
        timeoutMs: SESSION_END_WAIT_MS,
        intervalMs: 3_000,
        label: `the orphan reaper finalizes ${rung}'s silent session`,
      });

      const recording = await readOneRungPlaylist(host, cfg, owner, announce);
      assert.equal(recording.recording, true, `${rung}'s feed head is not its recording after the reap`);
      const recordingIndex = await readFeedIndex(host, cfg, owner, announce.topic);
      assert.ok(recordingIndex !== null, `the gateway resolved no index on ${rung}'s feed after its recording landed`);
      console.log(
        `  ${rung}'s recording stands at SOC index ${recordingIndex} with media sequence ${recording.mediaSequence}`,
      );

      await sleep(Math.max(0, SILENCE_MS - (Date.now() - Date.parse(quietAt))));
      const resumedAt = await host.nowIso();
      await resume();
      const sinceResume = async (): Promise<string> => host.logsSince(uploader, resumedAt);

      await waitFor(
        async () =>
          announcedRungs(await sinceResume()).some((line) => line.rung === rung && line.topic === announce.topic),
        {
          timeoutMs: RETURN_WAIT_MS,
          intervalMs: 3_000,
          label: `${rung} announces again on the topic it had, because its siblings kept the ladder group alive`,
        },
      );

      const returned = await checkRungPlaylistsLive(host, cfg, {
        log: sinceResume,
        rungs: [rung],
        minPublishes: RETURN_PUBLISHES,
        publishWaitMs: RETURN_WAIT_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
      });
      console.log(returned.summary);
      assert.equal(returned.refusal, null, returned.refusal ?? '');

      const afterResume = await sinceResume();
      const resumes = topicResumes(afterResume).filter((line) => line.streamId === announce.streamId);
      assert.equal(
        resumes.length,
        1,
        `${rung} reopened its topic and wrote ${resumes.length} resume line(s), where one says it read the head it ` +
          'continues. None is a session numbering itself from nothing over its own recording, the 2026-10-14 defect',
      );
      assert.equal(
        resumes[0].socIndex,
        recordingIndex,
        `${rung} resumed at SOC index ${resumes[0].socIndex} while the gateway resolves its feed head at ${recordingIndex}`,
      );
      assert.ok(
        resumes[0].mediaSequence > 0,
        `${rung} numbered its playlist from media sequence 0 over a feed that has one`,
      );
      const writtenAfter = manifestIndicesByRung(afterResume).get(rung) ?? [];
      const behind = writtenAfter.filter((index) => index <= recordingIndex);
      assert.deepEqual(behind, [], `${rung} wrote live playlists at or below its recording's index ${recordingIndex}`);

      const head = await readOneRungPlaylist(host, cfg, owner, announce);
      assert.ok(
        head.mediaSequence !== null && head.mediaSequence >= resumes[0].mediaSequence,
        `${rung}'s live playlist declares media sequence ${head.mediaSequence}, below the ${resumes[0].mediaSequence} ` +
          'it said it continues from, which hls.js reads as a parse error rather than a new segment',
      );

      await waitForMasterRungs(host, cfg, {
        owner,
        ladder: announce.ladder,
        expected: cfg.abrRungs,
        readTopics: topicsOf,
        timeoutMs: MASTER_WAIT_MS,
        label: `the master offers ${rung} again once it publishes`,
      });

      const whole = await log();
      assert.equal(
        staleWarningRefusal(staleManifestWarnings(whole)),
        null,
        staleWarningRefusal(staleManifestWarnings(whole)) ?? '',
      );
      const untouched = await checkRungPlaylistsLive(host, cfg, {
        log,
        rungs: siblings,
        minPublishes: WARMUP_PUBLISHES + RETURN_PUBLISHES,
        publishWaitMs: 0,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
      });
      console.log(untouched.summary);
      assert.equal(untouched.refusal, null, `a sibling of ${rung} was disturbed: ${untouched.refusal ?? ''}`);
    });

    it('records two sessions on the restarted rung and one on every other', async () => {
      const text = await log();
      const topics = announcedSessionTopics(text);
      const ladder = announcedRungs(text)[0]?.ladder ?? null;
      const feeds = rungFeedsOf(text);
      const { owner } = await discoverCatalogFeed(host, cfg);
      await publisher?.stop();
      publisher = undefined;

      await waitFor(async () => vodFinalizeCountFor(await log(), topics) >= 1, {
        timeoutMs: vodFinalizeWaitMs({ segmentSeconds: fragmentSecondsFor(cfg.segmentExpectation), pollMs: 3_000 }),
        intervalMs: 3_000,
        label: 'the broadcast finalizes to VOD after the stop',
      });

      const listing = await waitForRecordingListing(host, cfg, { owner, ladder, feeds }, RECORDING_WAIT_MS);
      console.log(describeRecording(listing.offered, listing.rungs));
      const refusal = recordingRefusal(listing.offered, listing.rungs, {
        rungs: cfg.abrRungs,
        sessions: new Map([[rung, 2]]),
        fragmentSeconds: fragmentSecondsFor(cfg.segmentExpectation) ?? 2,
        shortOnPurpose: [rung],
      });
      assert.equal(refusal, null, refusal ?? '');
    });
  },
);
