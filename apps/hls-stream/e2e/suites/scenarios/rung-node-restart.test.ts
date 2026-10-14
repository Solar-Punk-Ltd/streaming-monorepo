import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, containerNameFor, loadConfig } from '../../src/config.js';
import { makeHost, reportFailedRestore, uploaderHealth, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs } from '../../src/harness/logwatch.js';
import { waitForMasterRungs } from '../../src/harness/masterShape.js';
import { type Publisher, startPublisher } from '../../src/harness/publisher.js';
import { BEE_SERVICE_BY_RUNG, COORDINATOR_RUNG, nodesBehind } from '../../src/harness/publishers.js';
import { checkRungPlaylistsLive, staleManifestWarnings } from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { discoverCatalogFeed } from '../../src/harness/viewer.js';
import { sleep } from '../../src/harness/wait.js';

/**
 * One rung's own Bee node stopped for 20 s under a live ladder, then started again.
 *
 * `bee-outage-short` and `bee-outage-long` take every publisher node down together, so they say nothing about one rung
 * losing the node it alone publishes through while its siblings carry on. That rung's uploads and playlist writes fail
 * for the outage, so the master must stop offering it, and once the node is back its feed must move again and the
 * master offer it again. The siblings' nodes were never touched, so their playlists must not notice.
 *
 * ⚠️ The rung's own stale warnings are printed and not refused: every playlist it could not write while its node was
 * down is one, which is the uploader saying so correctly. The siblings are held to none.
 *
 * ⛔ Needs a ladder on a stage that gives the rung a node of its own, which `/health` is read to confirm, and never
 * touches the coordinator, whose node also writes the catalog and every master.
 */

const NODE_DOWN_MS = 20_000;
const PUBLISHES_PER_RUNG = 8;
const PUBLISH_WAIT_MS = 180_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const MASTER_WAIT_MS = 180_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const rung = cfg.abrRungs.filter((name) => name !== COORDINATOR_RUNG).at(-1) ?? null;

function skipReason(): string | false {
  if (!cfg.abrEnabled) {
    return 'ABR_ENABLED is off on this deployment, so there is no rung node to stop under a ladder';
  }
  return rung === null || BEE_SERVICE_BY_RUNG[rung] === undefined
    ? 'the ladder has no rung besides the coordinator with a Bee service of its own'
    : false;
}

describe('rung node restart: one rung loses its own node for 20s and comes back', { skip: skipReason() }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const target = rung as string;
  const node = containerNameFor(cfg.profile, BEE_SERVICE_BY_RUNG[target]);
  const siblings = cfg.abrRungs.filter((name) => name !== target);
  let publisher: Publisher | undefined;
  let startedAt: string;

  const log = async (): Promise<string> => host.logsSince(uploader, startedAt);

  before(async () => {
    const routed = nodesBehind((await uploaderHealth(host, cfg)).publishers, cfg.ports.beeUploaderApi);
    const own = routed.find((candidate) => candidate.rungs.includes(target));
    assert.ok(
      own !== undefined && own.rungs.length === 1,
      `${target} does not publish through a node of its own on this stage, so stopping ${node} would not isolate it`,
    );
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    startedAt = await host.nowIso();
    publisher = startPublisher(cfg);
  });

  after(async () => {
    await host.start(node).catch(reportFailedRestore(node));
    await publisher?.stop();
  });

  it('drops the rung from the master while its node is down, and takes it back once its feed moves again', async () => {
    const warm = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs: cfg.abrRungs,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWaitMs: PUBLISH_WAIT_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
    });
    assert.equal(warm.refusal, null, `the ladder was not healthy before the fault: ${warm.refusal ?? ''}`);

    const text = await log();
    const ladder = announcedRungs(text)[0]?.ladder;
    assert.ok(ladder !== undefined, 'no rung announced a ladder, so there is no master to read');
    const { owner } = await discoverCatalogFeed(host, cfg);
    const topicsOf = async (): Promise<ReadonlyMap<string, string>> =>
      new Map(announcedRungs(await log()).map((line) => [line.topic, line.rung]));

    const downAt = Date.now();
    await host.stop(node);
    await waitForMasterRungs(host, cfg, {
      owner,
      ladder,
      expected: siblings,
      readTopics: topicsOf,
      timeoutMs: MASTER_WAIT_MS,
      label: `the master stops offering ${target} while its node is down`,
    });
    const droppedAfterS = (Date.now() - downAt) / 1000;
    await sleep(Math.max(0, NODE_DOWN_MS - (Date.now() - downAt)));
    const backAt = await host.nowIso();
    await host.start(node);

    const returned = await checkRungPlaylistsLive(host, cfg, {
      log: async () => host.logsSince(uploader, backAt),
      rungs: [target],
      namesFrom: text,
      minPublishes: PUBLISHES_PER_RUNG,
      publishWaitMs: PUBLISH_WAIT_MS,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
      refuseStale: false,
    });
    console.log(returned.summary);
    assert.equal(returned.refusal, null, returned.refusal ?? '');

    await waitForMasterRungs(host, cfg, {
      owner,
      ladder,
      expected: cfg.abrRungs,
      readTopics: topicsOf,
      timeoutMs: MASTER_WAIT_MS,
      label: `the master offers ${target} again once its node is back`,
    });

    const siblingsHeld = await checkRungPlaylistsLive(host, cfg, {
      log,
      rungs: siblings,
      minPublishes: PUBLISHES_PER_RUNG * 2,
      publishWaitMs: 0,
      headWaitMs: HEAD_ADVANCE_WAIT_MS,
      refuseStale: false,
    });
    console.log(siblingsHeld.summary);
    assert.equal(siblingsHeld.refusal, null, `a sibling of ${target} was disturbed: ${siblingsHeld.refusal ?? ''}`);

    const whole = await log();
    const rungOf = new Map(announcedRungs(whole).map((line) => [line.streamId, line.rung]));
    const staleByRung = staleManifestWarnings(whole).map((warning) => rungOf.get(warning.streamId) ?? warning.streamId);
    const siblingStale = staleByRung.filter((name) => name !== target);
    console.log(
      `  observations, none of them asserted. the master dropped ${target} ${droppedAfterS.toFixed(1)}s after its node ` +
        `stopped, and ${target} wrote ${staleByRung.length - siblingStale.length} stale warning(s) while it was down`,
    );
    assert.deepEqual(
      siblingStale,
      [],
      `rungs whose nodes were never touched called their playlist stale: ${siblingStale.join(', ')}`,
    );
  });
});
