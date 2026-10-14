import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { byteSourceArmRefusal, viewerPlaybackRefusal } from '../../src/harness/browserVerdict.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { segmentSecondsOf } from '../../src/browser/rungManifest.js';
import { lateJoinRefusal } from '../../src/harness/lateJoin.js';
import { segmentIndicesByStream } from '../../src/harness/logwatch.js';
import { fragmentSecondsFor, readOneRungPlaylist, rungFeedsOf } from '../../src/harness/manifestContractLive.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { requireByteSource, viewerGate } from '../../src/viewerCoverage.js';

/**
 * A viewer who joins three minutes into a broadcast starts at its live edge, not at its first segment.
 *
 * Every other viewer suite joins within seconds of the publisher, when the live edge and the first segment are the same
 * few seconds of media, so a player that always started at media sequence 0 would pass all of them. Three minutes in,
 * starting at 0 means watching from the beginning of a window the player should have skipped, three minutes behind
 * everyone else, and on a topic that inherited a prefix from an earlier session it means starting inside that earlier
 * session.
 *
 * ⛔ The reading is where in the broadcast the player started, which is correctness, not latency. A live playlist is a
 * window of about 4096 bytes, 30 to 50 entries, read off the gateway at the join, and a start at its first entry sits
 * that window behind live. The bound is the client's own catch-up limit, out of its player configuration, far inside
 * that window and well outside where the client aims. See `src/harness/lateJoin.ts`. How far behind live the viewer
 * sat is printed and never asserted beyond that bound.
 */

const JOIN_AFTER_MS = 180_000;
const WATCH_MINUTES = 2;
const FIRST_SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;
/**
 * The most `/bytes/` requests an in-tab arm may make across the whole run, the same ceiling V1 sets and for its
 * reason: an in-tab arm reads through the gateway only while its own node boots. Joining late adds no gateway read.
 */
const MAX_WEEB3_SEGMENT_REQUESTS = 9;

const cfg = loadConfig();
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
const skip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

describe('a viewer joining three minutes in starts at the live edge', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let publisher: Publisher | undefined;
  let startedAt: string;

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await publisher?.stop();
  });

  it('did not start at the beginning of a broadcast already three minutes old', async () => {
    await waitFor(async () => segmentIndicesByStream(await host.logsSince(uploader, startedAt)).size > 0, {
      timeoutMs: FIRST_SEGMENT_WAIT_MS,
      intervalMs: 3_000,
      label: 'the broadcast uploads its first segment',
    });
    await sleep(Math.max(0, JOIN_AFTER_MS - (Date.now() - Date.parse(startedAt))));
    const ageAtJoinS = (Date.now() - Date.parse(startedAt)) / 1000;
    const { owner } = await discoverCatalogFeed(host, cfg);
    const [feed] = rungFeedsOf(await host.logsSince(uploader, startedAt));
    assert.ok(feed !== undefined, 'the broadcast announced no feed, so the window a joiner is handed cannot be read');
    const window = await readOneRungPlaylist(host, cfg, owner, feed);
    const seconds = window.playlist === null ? [] : segmentSecondsOf(window.playlist);
    const windowSeconds = seconds.reduce((total, s) => total + s, 0);
    const fragmentSeconds = fragmentSecondsFor(cfg.segmentExpectation) ?? Math.max(1, ...seconds);

    const result = await runBrowserArm(host, cfg, { backend: requireByteSource(backend), watchMinutes: WATCH_MINUTES });
    console.log(
      `  the broadcast was ${ageAtJoinS.toFixed(0)}s old at the join, and the ` +
        `viewer sat ${result.behindLive.joinS?.toFixed(1) ?? '?'}s behind live at its join and ` +
        `${result.behindLive.medianS?.toFixed(1) ?? '?'}s at the median, with a live window of ` +
        `${windowSeconds.toFixed(1)}s on ${feed.rung ?? 'its one rendition'}`,
    );
    assert.equal(viewerPlaybackRefusal(result), null, viewerPlaybackRefusal(result) ?? '');
    const notItsCondition = byteSourceArmRefusal(result, { maxSegmentRequests: MAX_WEEB3_SEGMENT_REQUESTS });
    assert.equal(notItsCondition, null, `this arm is not the byte source it is filed as: ${notItsCondition}`);
    const refusal = lateJoinRefusal({ joinS: result.behindLive.joinS, windowSeconds, fragmentSeconds });
    assert.equal(refusal, null, refusal ?? '');
  });
});
