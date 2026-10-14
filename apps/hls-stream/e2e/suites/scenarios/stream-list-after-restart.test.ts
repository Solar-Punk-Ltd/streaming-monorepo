import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import { makeHost, reportFailedRestore, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedSessionTopics, segmentIndicesByStream, vodFinalizeCountFor } from '../../src/harness/logwatch.js';
import { fragmentSecondsFor } from '../../src/harness/manifestContractLive.js';
import { startPublisher } from '../../src/harness/publisher.js';
import { vodFinalizeWaitMs } from '../../src/harness/recording.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import {
  type CatalogEntry,
  type CatalogFeed,
  discoverCatalogFeed,
  entryCarriesTopic,
  fetchCatalog,
} from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * G19: the stream list the catalog publishes still names every broadcast after an uploader restart whose read-back of
 * that list was slow.
 *
 * On start the uploader reads the catalog it published before and writes every later entry on top of it. A read that
 * is slow or comes back short, and is taken as the whole list anyway, writes a shorter list over the real one, and the
 * broadcasts it dropped can no longer be found by a viewer. So two broadcasts are recorded, the uploader is restarted
 * while the coordinator node, the one that writes and reads the catalog, is paused for 30 s, and a third broadcast
 * then has to land in a catalog that still lists the first two.
 *
 * ⛔ Pauses rather than stops the coordinator, so the read is slow rather than refused, which is the case that can be
 * mistaken for an answer.
 */

const BROADCAST_SECONDS = 60;
const COORDINATOR_PAUSE_MS = 30_000;
const FIRST_SEGMENT_WAIT_MS = 120_000;
const REBOOT_WAIT_MS = 120_000;
const CATALOG_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();

/** One catalog entry's identity, the feed it names. */
function entryKey(entry: CatalogEntry): string {
  return `${entry.owner}/${entry.topic}`;
}

describe('G19: the stream list keeps every broadcast across a restart with a slow read-back', () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const coordinator = containerName(cfg, 'bee-uploader');
  let feed: CatalogFeed;
  const recorded: CatalogEntry[] = [];

  /** Broadcast on one stream path, stop, and hand back the catalog entry it finalized into. */
  async function broadcastAndFinish(streamPath: string): Promise<CatalogEntry> {
    const startedAt = await host.nowIso();
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const publisher = startPublisher(cfg, { streamPath });
    try {
      await waitFor(async () => segmentIndicesByStream(await log()).size > 0, {
        timeoutMs: FIRST_SEGMENT_WAIT_MS,
        intervalMs: 2_000,
        label: `the first segment of ${streamPath} uploads`,
      });
      await sleep(BROADCAST_SECONDS * 1_000);
    } finally {
      await publisher.stop();
    }
    const topics = new Set(announcedSessionTopics(await log()));
    await waitFor(async () => vodFinalizeCountFor(await log(), [...topics]) >= 1, {
      timeoutMs: vodFinalizeWaitMs({ segmentSeconds: fragmentSecondsFor(cfg.segmentExpectation), pollMs: 3_000 }),
      intervalMs: 3_000,
      label: `${streamPath} finalizes to VOD`,
    });
    let entry: CatalogEntry | undefined;
    await waitFor(
      async () => {
        entry = (await fetchCatalog(host, cfg, feed).catch(() => [])).find(
          (candidate) => entryCarriesTopic(candidate, topics) && candidate.state === 'vod',
        );
        return entry !== undefined;
      },
      { timeoutMs: CATALOG_WAIT_MS, intervalMs: 5_000, label: `${streamPath} reaches the catalog as vod` },
    );
    await waitForIdle(host, cfg);
    return entry as CatalogEntry;
  }

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    feed = await discoverCatalogFeed(host, cfg);
  });

  after(async () => {
    // ⛔ A paused coordinator left behind stops every later suite's catalog and every master.
    await host.unpause(coordinator).catch(() => undefined);
    if (!(await host.isRunning(uploader))) {
      await host.start(uploader).catch(reportFailedRestore(uploader));
    }
  });

  it('records two broadcasts in the catalog', async () => {
    recorded.push(await broadcastAndFinish(`${cfg.streamPath}`));
    recorded.push(await broadcastAndFinish(`${cfg.streamPath}2`));
    assert.notEqual(entryKey(recorded[0]), entryKey(recorded[1]), 'the two broadcasts finalized into one entry');
  });

  it('still lists both, and the third, after a restart whose read-back of the list was slow', async () => {
    assert.equal(recorded.length, 2, 'the two broadcasts before the restart did not both record');
    const listedBefore = await fetchCatalog(host, cfg, feed);
    const wanted = new Set([...listedBefore.map(entryKey), ...recorded.map(entryKey)]);

    await host.pause(coordinator);
    try {
      await host.restart(uploader);
      await sleep(COORDINATOR_PAUSE_MS);
    } finally {
      await host.unpause(coordinator);
    }
    await waitFor(
      async () => {
        try {
          return (await uploaderHealth(host, cfg)).status !== undefined;
        } catch {
          return false;
        }
      },
      { timeoutMs: REBOOT_WAIT_MS, intervalMs: 3_000, label: 'the uploader answers again after its restart' },
    );

    const third = await broadcastAndFinish(`${cfg.streamPath}3`);
    wanted.add(entryKey(third));
    const listed = await fetchCatalog(host, cfg, feed);
    const missing = [...wanted].filter((key) => !listed.some((entry) => entryKey(entry) === key));
    console.log(
      `  the catalog listed ${listedBefore.length} entries before the restart and ${listed.length} after the third`,
    );
    assert.deepEqual(
      missing,
      [],
      `the catalog lost ${missing.length} of the entries it listed before the restart, so a slow read-back was ` +
        'written over the real list and those broadcasts can no longer be found',
    );
  });
});
