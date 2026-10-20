import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { byteSourceFromEnv } from '../../src/browser/fetchBackendSweep.js';
import { containerName, loadConfig } from '../../src/config.js';
import { HEALTH_STATUS_DEGRADED } from '../../src/harness/batchDrain.js';
import { type BrowserArmResult, runBrowserArm } from '../../src/harness/browser.js';
import { makeHost, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { waitForMasterRungs } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { COORDINATOR_RUNG, nodesBehind } from '../../src/harness/publishers.js';
import { checkRungPlaylistsLive } from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { sleep, waitFor } from '../../src/harness/wait.js';
import { viewerGate } from '../../src/viewerCoverage.js';

/**
 * A rung that never lands a single segment, under a ladder whose other rungs publish normally.
 *
 * It checks the never-started-rung fix (633abd6bc). Before it, a rung that never published was not one the dead-rung
 * rule knew about, so the master went on offering it and a viewer joining was handed a quality with nothing behind it.
 * A stage running a build without that fix fails this suite.
 *
 * The fault is a stage arming rather than something a suite does mid-broadcast: the uploader's `BEE_PUBLISHERS` entry
 * for one rung points at a port nothing listens on, so every upload on that rung is refused from the first segment.
 * That is a sharper fault than killing the rung's transcode, which races the encoder's own start. Arm it by editing
 * that rung's entry in the profile's env file and redeploying the uploader, run this with `E2E_NEVER_STARTS_RUNG` set
 * to the rung, and put the entry back and redeploy after. `before()` reads `/health` and refuses a stage whose routing
 * for that rung still reaches a node, so an unarmed stage is never read as the fault.
 *
 * For two minutes of broadcast: the master stops offering the dead rung once its siblings have published 4 segments,
 * the three others publish normally, `/health` reports the stream degraded, and a viewer watching is never told the
 * broadcast ended.
 *
 * ⛔ Skips, printed as skipped, unless `E2E_NEVER_STARTS_RUNG` names a rung of the ladder other than the coordinator.
 */

const NEVER_STARTS_VAR = 'E2E_NEVER_STARTS_RUNG';
const BROADCAST_MS = 120_000;
const SIBLING_SEGMENTS_BEFORE_DROP = 4;
const PUBLISH_WAIT_MS = 120_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const MASTER_WAIT_MS = 120_000;
const HEALTH_WAIT_MS = 60_000;
const VIEWER_WATCH_MINUTES = 2;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const deadRung = process.env[NEVER_STARTS_VAR]?.trim() ?? '';
const backend = byteSourceFromEnv(process.env.BROWSER_FETCH_BACKEND);
const viewerSkip = viewerGate(cfg.viewerExpectation, backend, cfg.browserRepoDir);

function skipReason(): string | false {
  if (deadRung === '') {
    return `SKIPPED, NOT PASSED: ${NEVER_STARTS_VAR} is not set, so no stage was armed with a rung that never starts`;
  }
  if (!cfg.abrRungs.includes(deadRung) || deadRung === COORDINATOR_RUNG) {
    return `${NEVER_STARTS_VAR}=${deadRung} is not a rung of this ladder other than the coordinator`;
  }
  return false;
}

describe('a rung that never starts leaves the ladder offering only what publishes', { skip: skipReason() }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const siblings = cfg.abrRungs.filter((name) => name !== deadRung);
  let publisher: Publisher | undefined;
  let startedAt: string;
  let viewer: Promise<BrowserArmResult> | null = null;

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

  before(async () => {
    const routed = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);
    const own = routed.find((node) => node.rungs.includes(deadRung));
    assert.ok(own !== undefined, `the uploader routes ${deadRung} nowhere, so this stage was armed some other way`);
    // curl exits non-zero on a refused connection, which `Host.run` throws on, so a throw is the armed answer.
    const reached = await host.localStatus({ port: own.port, address: own.address }, '/health', 5).catch(() => null);
    const answered = reached?.status ?? 0;
    assert.equal(
      answered,
      0,
      `${deadRung} is routed to port ${own.port} and something answered ${answered} there, so the stage is not ` +
        `armed and this broadcast would read a healthy rung as the fault. Point ${deadRung}'s BEE_PUBLISHERS entry at a ` +
        'closed port and redeploy the uploader first',
    );
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
    if (viewerSkip === false && backend !== null) {
      viewer = runBrowserArm(host, cfg, { backend, watchMinutes: VIEWER_WATCH_MINUTES });
    }
  });

  after(async () => {
    await viewer?.catch(() => undefined);
    await publisher?.stop();
  });

  it('publishes the other rungs normally and stops offering the dead one', async () => {
    const others = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs: siblings,
      minPublishes: SIBLING_SEGMENTS_BEFORE_DROP,
      publishWaitMs: PUBLISH_WAIT_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });
    console.log(others.summary);
    assert.equal(others.refusal, null, others.refusal ?? '');

    const text = await log();
    const ladder = announcedRungs(text)[0]?.ladder;
    assert.ok(ladder !== undefined, 'no rung announced a ladder, so there is no master to read');
    const { owner } = await discoverCatalogFeed(host, cfg);
    await waitForMasterRungs(host, cfg, {
      owner,
      ladder,
      expected: siblings,
      readTopics: async () => new Map(announcedRungs(await log()).map((line) => [line.topic, line.rung])),
      timeoutMs: MASTER_WAIT_MS,
      label: `the master offers only the rungs that publish, without ${deadRung}, which never landed a segment`,
    });

    await waitFor(async () => (await uploaderHealth(host, cfg)).status === HEALTH_STATUS_DEGRADED, {
      timeoutMs: HEALTH_WAIT_MS,
      intervalMs: 3_000,
      label: `/health reports the stream ${HEALTH_STATUS_DEGRADED} while ${deadRung} has never published`,
    });
    console.log(`  /health reasons: ${(await uploaderHealth(host, cfg)).reasons.join(', ') || 'none'}`);

    await sleep(Math.max(0, BROADCAST_MS - (Date.now() - Date.parse(startedAt))));
  });

  it('never tells a viewer the broadcast ended', { skip: viewerSkip }, async () => {
    assert.ok(viewer !== null, 'no viewer arm was started');
    const result = await viewer;
    console.log(`  feed states the viewer met, in order: ${result.feedStatesSeen.join(', ')}`);
    assert.equal(
      result.reachedEndedOverlay,
      false,
      `the viewer was told the broadcast ended because ${deadRung} never started`,
    );
    assert.equal(result.fatalErrors, 0, `the player hit ${result.fatalErrors} fatal error(s)`);
  });
});
