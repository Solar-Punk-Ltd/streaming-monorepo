import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { containerName, loadConfig } from '../../src/config.js';
import {
  AdminApi,
  type AdminMode,
  adminModeFrom,
  adminSkipReason,
  adminUnreachableRefusals,
  declaredStreamPath,
  requireAdminMode,
} from '../../src/harness/adminApi.js';
import { type DeclaredStream, prepareDeclaredStream } from '../../src/harness/adminBroadcast.js';
import { makeHost, reportFailedRestore, waitForIdle } from '../../src/harness/host.js';
import { announcedRungs, segmentIndicesByStream, vodFinalizeCountFor } from '../../src/harness/logwatch.js';
import { fragmentSecondsFor } from '../../src/harness/manifestContractLive.js';
import { describeMaster, masterRungRefusal, masterRungsOf, readLadderMaster } from '../../src/harness/masterShape.js';
import { startPublisherAt } from '../../src/harness/publisher.js';
import { vodFinalizeWaitMs } from '../../src/harness/recording.js';
import { checkRungPlaylistsLive } from '../../src/harness/rungPublishing.js';
import { requireStageStamps } from '../../src/harness/stageStamps.js';
import { sleep, waitFor } from '../../src/harness/wait.js';

/**
 * Admin mode: the admin backend is away, at the start of a broadcast and in the middle of one.
 *
 * In admin mode the uploader asks the admin about every broadcast before it takes it, and fails closed: a lookup that
 * does not complete within its 5 s deadline refuses the publish (`engines/adminGate.ts`), because a broadcast the admin
 * cannot vouch for is one nobody declared. So with the admin stopped, a broadcast to a declared key is refused with
 * the admin-mode line and publishes nothing.
 *
 * Once a broadcast is running the admin is only told about it, so an admin that goes away for 30 s mid-broadcast must
 * cost no rung its live playlist, and once it is back the master still offers every rung and the broadcast finalizes
 * into a row the admin calls `vod`.
 *
 * ⚠️ The admin's own merged ladder is not compared with the master. The console's stream routes do not carry it yet,
 * only the uploader's internal rendition route does, and this harness holds no uploader token.
 *
 * ⛔ Stops and starts the admin backend's container, named in `E2E_ADMIN_CONTAINER`, which must run on the deployment
 * host's own docker, the one `E2E_SSH_TARGET` reaches. An admin on another machine cannot be stopped from here. Skips,
 * printed as skipped, without it and the other admin settings.
 */

const REFUSAL_WAIT_MS = 60_000;
/** How long a refused broadcast is watched for any upload at all. */
const REFUSED_WATCH_MS = 30_000;
const ADMIN_AWAY_MS = 30_000;
const ADMIN_BACK_WAIT_MS = 120_000;
const PUBLISHES_PER_RUNG = 10;
const PUBLISH_WAIT_MS = 180_000;
const HEAD_ADVANCE_WAIT_MS = 60_000;
const ADMIN_VOD_WAIT_MS = 300_000;
const MIN_STAMP_TTL_S = 600;

const cfg = loadConfig();
const admin = adminModeFrom(process.env);
const skip = adminSkipReason(admin, ['stream', 'container']);

describe('admin: a broadcast while the admin backend is away', { skip }, () => {
  const host = makeHost(cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  let mode: AdminMode;
  let api: AdminApi;
  let declared: DeclaredStream;

  const adminAnswers = async (): Promise<boolean> =>
    api.listStreams().then(
      () => true,
      () => false,
    );
  const bringAdminBack = async (): Promise<void> => {
    await host.start(mode.container as string);
    await waitFor(adminAnswers, { timeoutMs: ADMIN_BACK_WAIT_MS, intervalMs: 3_000, label: 'the admin answers again' });
  };

  before(async () => {
    await requireStageStamps(host, cfg, MIN_STAMP_TTL_S);
    await waitForIdle(host, cfg);
    mode = requireAdminMode(admin);
    api = new AdminApi(mode);
    declared = await prepareDeclaredStream(api, mode.streamId as string);
  });

  after(async () => {
    // ⛔ Whatever happened above, the admin is left running, or every later admin suite reads a stage it broke.
    if (mode?.container) {
      await host.start(mode.container).catch(reportFailedRestore(mode.container));
    }
  });

  it('refuses a broadcast to a declared key while the admin is away, and publishes nothing', async () => {
    const streamPath = declaredStreamPath(declared.stream);
    await host.stop(mode.container as string);
    const startedAt = await host.nowIso();
    const publisher = startPublisherAt(declared.url, declared.protocol);
    try {
      await waitFor(
        async () => adminUnreachableRefusals(await host.logsSince(uploader, startedAt)).includes(streamPath),
        {
          timeoutMs: REFUSAL_WAIT_MS,
          intervalMs: 2_000,
          label: `the uploader refuses ${streamPath} because the admin did not answer its lookup`,
        },
      );
      await sleep(REFUSED_WATCH_MS);
      const uploaded = [...segmentIndicesByStream(await host.logsSince(uploader, startedAt)).keys()].filter((id) =>
        id.startsWith(streamPath),
      );
      assert.deepEqual(
        uploaded,
        [],
        `a broadcast the admin could not vouch for uploaded segments on ${uploaded.join(', ')}`,
      );
    } finally {
      await publisher.stop();
      await bringAdminBack();
    }
  });

  it('keeps every rung publishing through an admin outage mid-broadcast, and finishes once it is back', async () => {
    await waitForIdle(host, cfg);
    const startedAt = await host.nowIso();
    const log = async (): Promise<string> => host.logsSince(uploader, startedAt);
    const publisher = startPublisherAt(declared.url, declared.protocol);
    let awayAt: string;
    try {
      const warm = await checkRungPlaylistsLive(host, cfg, {
        log,
        rungs: cfg.abrEnabled ? cfg.abrRungs : null,
        minPublishes: PUBLISHES_PER_RUNG,
        publishWaitMs: PUBLISH_WAIT_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
        owner: declared.stream.owner,
      });
      assert.equal(
        warm.refusal,
        null,
        `the broadcast was not healthy before the admin went away: ${warm.refusal ?? ''}`,
      );

      awayAt = await host.nowIso();
      await host.stop(mode.container as string);
      await sleep(ADMIN_AWAY_MS);
      await bringAdminBack();

      const through = await checkRungPlaylistsLive(host, cfg, {
        log: async () => host.logsSince(uploader, awayAt),
        rungs: cfg.abrEnabled ? cfg.abrRungs : null,
        namesFrom: await log(),
        minPublishes: PUBLISHES_PER_RUNG,
        publishWaitMs: PUBLISH_WAIT_MS,
        headWaitMs: HEAD_ADVANCE_WAIT_MS,
        owner: declared.stream.owner,
      });
      console.log(through.summary);
      assert.equal(through.refusal, null, through.refusal ?? '');

      const text = await log();
      const ladder = announcedRungs(text)[0]?.ladder;
      if (ladder !== undefined) {
        const master = await readLadderMaster(host, cfg, declared.stream.owner, ladder);
        const read = masterRungsOf(master, new Map(announcedRungs(text).map((line) => [line.topic, line.rung])));
        console.log(`  ${describeMaster(read, master)}`);
        assert.equal(masterRungRefusal(read, cfg.abrRungs), null, masterRungRefusal(read, cfg.abrRungs) ?? '');
      }
    } finally {
      await publisher.stop();
    }

    const topics = [...new Set(announcedRungs(await log()).map((line) => line.topic))];
    await waitFor(async () => vodFinalizeCountFor(await log(), topics) >= 1, {
      timeoutMs: vodFinalizeWaitMs({ segmentSeconds: fragmentSecondsFor(cfg.segmentExpectation), pollMs: 3_000 }),
      intervalMs: 3_000,
      label: 'the broadcast finalizes to VOD after the stop',
    });
    await waitFor(async () => (await api.getStream(declared.stream.id)).status === 'vod', {
      timeoutMs: ADMIN_VOD_WAIT_MS,
      intervalMs: 3_000,
      label: 'the admin, back from its outage, records the broadcast as vod',
    });
  });
});
