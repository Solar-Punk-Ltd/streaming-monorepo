import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { runBrowserArm } from '../../src/harness/browser.js';
import { viewerPlaybackRefusal } from '../../src/harness/browserVerdict.js';
import { makeHost, waitForIdle } from '../../src/harness/host.js';
import { segmentIndicesByStream } from '../../src/harness/logwatch.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
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
 * ⛔ The reading is where in the broadcast the player started, which is correctness, not latency. The bound is half the
 * broadcast's age at the join, far wider than any live offset the client targets and far narrower than the start of
 * the broadcast, so it separates the two answers without promising a number. How far behind live the viewer sat is
 * printed and never asserted.
 */

const JOIN_AFTER_MS = 180_000;
const WATCH_MINUTES = 2;
const FIRST_SEGMENT_WAIT_MS = 120_000;
const MIN_STAMP_TTL_S = 600;

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

    const result = await runBrowserArm(host, cfg, { backend: requireByteSource(backend), watchMinutes: WATCH_MINUTES });
    console.log(
      `  observations, none of them asserted. the broadcast was ${ageAtJoinS.toFixed(0)}s old at the join, and the ` +
        `viewer sat ${result.behindLive.joinS?.toFixed(1) ?? '?'}s behind live at its join and ` +
        `${result.behindLive.medianS?.toFixed(1) ?? '?'}s at the median`,
    );
    assert.equal(viewerPlaybackRefusal(result), null, viewerPlaybackRefusal(result) ?? '');
    assert.ok(result.behindLive.joinS !== null, 'the arm read no position at the join, so where it started is unknown');
    assert.ok(
      result.behindLive.joinS < ageAtJoinS / 2,
      `the viewer started ${result.behindLive.joinS.toFixed(1)}s behind live in a broadcast ${ageAtJoinS.toFixed(0)}s ` +
        'old, so it began at the start of the window rather than at the live edge',
    );
  });
});
