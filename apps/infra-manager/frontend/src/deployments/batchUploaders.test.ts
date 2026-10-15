/**
 * What the Storage card says after a batch is set with Use (SPDV-1437).
 *
 * Use stores the batch and restarts nothing, and a stream uploader reads its
 * batch once, when it starts. So until the uploader restarts it keeps paying
 * with the batch it started with, while the table used to mark the stored one
 * "in use". These cases pin the notice that says so where the operator
 * clicked, the Apply now that restarts what has to restart, the confirmation
 * a live broadcast gets first, the chip on each batch, and the settings being
 * read again the moment a Use lands.
 *
 * Unit test, no browser. `pnpm test` in frontend/.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type DeploymentSettingEntry,
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  type IngestHealthReading,
} from '@streaming-infra-manager/common';

import {
  type ApplyConfirm,
  applyNow,
  type BatchUploader,
  batchChipOf,
  batchNotice,
  batchUseOf,
  broadcastStateOf,
  ownUploaderOf,
  readStageCatalogs,
  setBatchAndReread,
  stageUploaderOf,
  stagesUsingNode,
} from './batchUploaders';
import { shortHex } from '../format';
import type { Profile } from '../types';
import { settingsReadKey } from './settings/useDeploymentSettings';
import { stageReadKey } from './useBatchUploaders';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

function entry(overrides: Partial<DeploymentSettingEntry> & { key: string }): DeploymentSettingEntry {
  return {
    section: '',
    description: '',
    declared: true,
    secret: false,
    sampleValue: null,
    versionSet: false,
    versionValue: null,
    stored: false,
    storedValue: null,
    value: null,
    source: 'manager',
    owner: 'stamp',
    field: null,
    services: ['stream-uploader'],
    running: 'same',
    runningValue: null,
    engineSetting: null,
    ...overrides,
  };
}

function catalog(
  entries: DeploymentSettingEntry[],
  over: Partial<DeploymentSettingsCatalog> = {},
): DeploymentSettingsCatalog {
  const behind = entries.filter((candidate) => candidate.running === 'differs');
  return {
    instanceId: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    buildId: 'build-1',
    entries,
    drift: {
      keys: behind.map((candidate) => candidate.key),
      services: behind.length > 0 ? ['stream-uploader'] : [],
      fullRedeploy: false,
    },
    running: true,
    engine: 'srs',
    abr: false,
    engineSettingsProblem: null,
    ...over,
  };
}

const publishers = (batch720: string) =>
  `360p@http://pool.example:1633<${OTHER}> 720p@http://pool.example:1653<${batch720}>`;

function uploader(over: Partial<BatchUploader> = {}): BatchUploader {
  return {
    name: 'main-stage',
    instanceId: '00000000-0000-4000-8000-000000000001',
    own: true,
    savedBatchId: NEW,
    runningBatchId: OLD,
    behind: true,
    recreates: ['stream-uploader'],
    batchKey: 'STAMP',
    changedKeys: ['STAMP'],
    savedPaysWithNode: true,
    ...over,
  };
}

function stage(over: Partial<BatchUploader> = {}): BatchUploader {
  return uploader({
    name: 'stage-a',
    own: false,
    batchKey: 'BEE_PUBLISHERS',
    changedKeys: ['BEE_PUBLISHERS'],
    ...over,
  });
}

const LIVE: IngestHealthReading = {
  state: 'read',
  windowSeconds: 60,
  srt: {
    state: 'measured',
    reports: 6,
    connections: 1,
    counts: { received: 1000, lost: 0, dropped: 0, retransmitted: 0 },
    percent: { lost: 0, dropped: 0, retransmitted: 0 },
    verdict: 'healthy',
  },
  rtmp: { state: 'no_reports' },
} as IngestHealthReading;

const IDLE: IngestHealthReading = {
  state: 'read',
  windowSeconds: 60,
  srt: { state: 'no_reports' },
  rtmp: { state: 'no_reports' },
};

describe("a single-node streamer's own uploader", () => {
  it('is behind after a Use, naming the saved batch and the one it still pays with', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([entry({ key: 'STAMP', value: NEW, running: 'differs', runningValue: OLD })]),
    );

    assert.deepEqual(own, uploader());
  });

  it('is not behind once it runs the saved batch', () => {
    const own = ownUploaderOf('main-stage', catalog([entry({ key: 'STAMP', value: NEW, runningValue: NEW })]));

    assert.equal(own?.behind, false);
    assert.equal(own?.runningBatchId, NEW);
  });

  it('is not behind while the deployment is stopped, because its Start uses the saved batch anyway', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([entry({ key: 'STAMP', value: NEW, running: 'not-running' })], { running: false }),
    );

    assert.equal(own?.behind, false);
  });

  it('is absent where the list has no STAMP, so nothing is claimed about an uploader', () => {
    assert.equal(ownUploaderOf('main-stage', catalog([entry({ key: 'LOG_LEVEL' })])), null);
  });

  it('offers nothing for a Use when it publishes through a pool, which STAMP does not reach', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([
        entry({ key: 'STAMP', value: NEW, running: 'differs', runningValue: OLD }),
        entry({ key: 'BEE_PUBLISHERS', value: publishers(OTHER), runningValue: publishers(OTHER) }),
      ]),
    );

    assert.ok(own);
    assert.equal(own.behind, false);
    assert.equal(own.savedPaysWithNode, false);
    assert.equal(own.runningBatchId, null);
    assert.equal(batchUseOf(NEW, NEW, [own]), null);
    assert.equal(batchUseOf(OLD, NEW, [own]), null);
    assert.equal(batchNotice(NEW, [own]), null);
  });

  it('marks the local batch it still runs, and offers no Apply, while it waits to switch to a pool', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([
        entry({ key: 'STAMP', value: NEW, running: 'differs', runningValue: OLD }),
        entry({ key: 'BEE_PUBLISHERS', value: publishers(OTHER), running: 'differs', runningValue: null }),
      ]),
    );

    assert.equal(own?.behind, false);
    assert.equal(own?.runningBatchId, OLD);
    assert.equal(batchUseOf(OLD, NEW, own ? [own] : []), 'running-not-saved');
    assert.equal(batchUseOf(NEW, NEW, own ? [own] : []), null);
  });

  it('is behind on the saved batch while it waits to switch from a pool to its own node', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([
        entry({ key: 'STAMP', value: NEW, running: 'differs', runningValue: OLD }),
        entry({ key: 'BEE_PUBLISHERS', value: null, running: 'differs', runningValue: publishers(OTHER) }),
      ]),
    );

    assert.equal(own?.behind, true);
    assert.equal(own?.savedPaysWithNode, true);
    assert.equal(own?.runningBatchId, null);
    assert.equal(batchUseOf(NEW, NEW, own ? [own] : []), 'saved-waiting');
  });
});

describe('the stages a rung publishes for', () => {
  const profiles = [
    { name: 'pool-720p', bee_publishers: null },
    { name: 'stage-a', bee_publishers: publishers(NEW) },
    { name: 'stage-b', bee_publishers: publishers(OLD) },
    { name: 'stage-other', bee_publishers: publishers(OTHER) },
    { name: 'plain-stream', bee_publishers: '' },
  ];

  it('are the stages whose pool string names a batch this node holds for this rung', () => {
    assert.deepEqual(stagesUsingNode(profiles, '720p', [OLD, NEW]), ['stage-a', 'stage-b']);
  });

  it('match a batch id whatever its case or prefix', () => {
    assert.deepEqual(stagesUsingNode(profiles, '720p', [`0x${NEW.toUpperCase()}`]), ['stage-a']);
  });

  it('are none for another rung', () => {
    assert.deepEqual(stagesUsingNode(profiles, '1080p', [OLD, NEW]), []);
  });

  it('read the rung out of the saved and the running pool strings', () => {
    const read = stageUploaderOf(
      'stage-a',
      catalog([
        entry({ key: 'BEE_PUBLISHERS', value: publishers(NEW), running: 'differs', runningValue: publishers(OLD) }),
      ]),
      '720p',
    );

    assert.deepEqual(read, stage());
  });

  it('are not behind on this rung when only another rung changed', () => {
    const otherRungMoved = `360p@http://pool.example:1633<${NEW}> 720p@http://pool.example:1653<${OLD}>`;
    const stage = stageUploaderOf(
      'stage-a',
      catalog([
        entry({ key: 'BEE_PUBLISHERS', value: otherRungMoved, running: 'differs', runningValue: publishers(OLD) }),
      ]),
      '720p',
    );

    assert.equal(stage?.behind, false);
  });

  it('are behind when the string differs and nothing records what the uploader runs', () => {
    const stage = stageUploaderOf(
      'stage-a',
      catalog([entry({ key: 'BEE_PUBLISHERS', value: publishers(NEW), running: 'differs' })]),
      '720p',
    );

    assert.equal(stage?.behind, true);
    assert.equal(stage?.runningBatchId, null);
  });
});

describe('the chip on each batch', () => {
  it('marks the batch the running uploader pays with as in use, and the saved one as waiting for Apply', () => {
    const uploaders = [uploader()];

    assert.equal(batchUseOf(OLD, NEW, uploaders), 'running-not-saved');
    assert.equal(batchUseOf(NEW, NEW, uploaders), 'saved-waiting');
    assert.equal(batchUseOf(OTHER, NEW, uploaders), null);
    assert.deepEqual(batchChipOf('running-not-saved', false), { label: 'in use until Apply', color: 'warning' });
    assert.deepEqual(batchChipOf('saved-waiting', false), { label: 'saved, not in use until Apply', color: 'info' });
  });

  it('marks the saved batch in use once the uploader runs it', () => {
    const uploaders = [uploader({ runningBatchId: NEW, behind: false })];

    assert.equal(batchUseOf(NEW, NEW, uploaders), 'in-use');
    assert.equal(batchUseOf(OLD, NEW, uploaders), null);
    assert.deepEqual(batchChipOf('in-use', false), { label: 'in use', color: 'default' });
    assert.deepEqual(batchChipOf('in-use', true), { label: 'in use, expired', color: 'error' });
  });

  it('keeps the saved batch in use where nothing records what an uploader runs', () => {
    assert.equal(batchUseOf(NEW, NEW, []), 'in-use');
    assert.equal(batchUseOf(NEW, NEW, [uploader({ runningBatchId: null, behind: false })]), 'in-use');
    assert.equal(batchUseOf(OLD, NEW, []), null);
  });

  it('keeps the saved batch waiting for Apply while one stage runs it and another is still behind on it', () => {
    const uploaders = [
      uploader({ name: 'stage-a', own: false, runningBatchId: NEW, behind: false }),
      uploader({ name: 'stage-b', own: false }),
    ];

    assert.equal(batchUseOf(NEW, NEW, uploaders), 'saved-waiting');
    assert.equal(batchUseOf(OLD, NEW, uploaders), 'running-not-saved');
  });

  it('keeps the saved batch waiting on a rung page while one stage restarted on it and another still pays with the old one', () => {
    const rungStage = (name: string, running: string) =>
      stageUploaderOf(
        name,
        catalog([
          entry({
            key: 'BEE_PUBLISHERS',
            value: publishers(NEW),
            running: running === NEW ? 'same' : 'differs',
            runningValue: publishers(running),
          }),
        ]),
        '720p',
      );
    const uploaders = [rungStage('stage-a', NEW), rungStage('stage-b', OLD)].flatMap((read) => (read ? [read] : []));

    assert.equal(batchUseOf(NEW, NEW, uploaders), 'saved-waiting');
    assert.equal(batchUseOf(OLD, NEW, uploaders), 'running-not-saved');
  });

  it('marks the saved batch as waiting for Apply when an uploader is behind on it and nothing records what it runs', () => {
    const uploaders = [uploader({ runningBatchId: null })];

    assert.equal(batchUseOf(NEW, NEW, uploaders), 'saved-waiting');
    assert.equal(batchUseOf(OLD, NEW, uploaders), null);
  });
});

describe('the notice on the stamp card', () => {
  it('says nothing when every uploader runs the saved batch', () => {
    assert.equal(batchNotice(NEW, [uploader({ runningBatchId: NEW, behind: false })]), null);
  });

  it('says on its own page that the saved batch waits for Apply, and what Apply now recreates', () => {
    const notice = batchNotice(NEW, [uploader()]);

    assert.equal(
      notice?.lead,
      `Batch ${shortHex(NEW)} is saved, but the running uploader still pays with batch ${shortHex(OLD)} until it restarts.`,
    );
    assert.deepEqual(notice?.rows, [
      { name: 'main-stage', own: true, what: 'Apply now applies STAMP and recreates stream-uploader.' },
    ]);
  });

  it('names the batch it still pays with as the one it started with when nothing records it', () => {
    assert.match(batchNotice(NEW, [uploader({ runningBatchId: null })])?.lead ?? '', /the batch it started with/);
  });

  it('names every stage that is behind on a rung page, each with what its Apply recreates', () => {
    const notice = batchNotice(NEW, [
      stage({ recreates: 'all' }),
      stage({ name: 'stage-b', runningBatchId: NEW, behind: false }),
      stage({ name: 'stage-c', recreates: ['srs', 'stream-uploader'], changedKeys: ['BEE_PUBLISHERS', 'SRT_LATENCY'] }),
    ]);

    assert.match(notice?.lead ?? '', /is saved for the stages this rung publishes for/);
    assert.match(
      notice?.lead ?? '',
      /Each stage's uploader still pays with the batch it started with until it restarts/,
    );
    assert.deepEqual(notice?.rows, [
      { name: 'stage-a', own: false, what: 'Apply now applies BEE_PUBLISHERS and redeploys every service of stage-a.' },
      {
        name: 'stage-c',
        own: false,
        what: 'Apply now applies BEE_PUBLISHERS and SRT_LATENCY and recreates srs and stream-uploader. SRT_LATENCY was saved earlier and not applied yet.',
      },
    ]);
  });

  it('names every setting Apply now applies, read from what the deployment is behind on', () => {
    const own = ownUploaderOf(
      'main-stage',
      catalog([
        entry({ key: 'STAMP', value: NEW, running: 'differs', runningValue: OLD }),
        entry({ key: 'LOG_LEVEL', value: 'debug', running: 'differs', runningValue: 'info' }),
      ]),
    );

    assert.deepEqual(own?.changedKeys, ['STAMP', 'LOG_LEVEL']);
    assert.equal(own?.batchKey, 'STAMP');
  });

  it('carries no em-dash and no semicolon', () => {
    const notice = batchNotice(NEW, [uploader({ changedKeys: ['STAMP', 'LOG_LEVEL'] }), stage({ recreates: 'all' })]);
    const text = JSON.stringify(notice);

    assert.doesNotMatch(text, /[—;]/);
  });
});

describe('whether a broadcast is live', () => {
  it('is live while SRS reports a publisher over SRT or RTMP', () => {
    assert.equal(broadcastStateOf(LIVE), 'live');
    assert.equal(
      broadcastStateOf({ ...IDLE, rtmp: { state: 'measured', reports: 3, connections: 1, incomingKbps: 2500 } }),
      'live',
    );
  });

  it('cannot tell from an RTMP report SRS did not attribute to a vhost, which may be a ladder rung', () => {
    assert.equal(broadcastStateOf({ ...IDLE, rtmp: { state: 'unattributed' } }), 'unknown');
    assert.equal(broadcastStateOf({ ...LIVE, rtmp: { state: 'unattributed' } } as IngestHealthReading), 'live');
  });

  it('is quiet, never idle, when SRS reported nobody publishing, since a publisher that connected moments ago has no report yet', () => {
    assert.equal(broadcastStateOf(IDLE), 'quiet');
  });

  it('is not known when the log could not be read, the engine is not SRS, or the manager did not answer', () => {
    assert.equal(broadcastStateOf({ state: 'unreadable', windowSeconds: 60 }), 'unknown');
    assert.equal(broadcastStateOf({ state: 'not_srs', windowSeconds: 60 }), 'unknown');
    assert.equal(broadcastStateOf(null), 'unknown');
  });
});

describe('Apply now', () => {
  function harness(reading: IngestHealthReading | Error | 'stalls') {
    const calls: string[] = [];
    let asked: ApplyConfirm | null = null;
    const deps = {
      readIngest: async (name: string) => {
        calls.push(`read ${name}`);
        if (reading === 'stalls') return new Promise<IngestHealthReading>(() => undefined);
        if (reading instanceof Error) throw reading;
        return reading;
      },
      readDeadlineMs: 20,
      confirm: (request: ApplyConfirm) => {
        calls.push('confirm');
        asked = request;
      },
      apply: async (name: string, instanceId: string): Promise<DeploymentSettingsApplied> => {
        calls.push(`apply ${name} ${instanceId}`);
        return { recreated: ['stream-uploader'] };
      },
      done: async (applied: DeploymentSettingsApplied) => {
        calls.push(`done ${JSON.stringify(applied.recreated)}`);
      },
    };
    return { calls, deps, asked: () => asked };
  }

  it('asks first while the stream is live, saying the broadcast pauses while the uploader writes its recording, for up to minutes', async () => {
    const run = harness(LIVE);

    await applyNow(uploader(), run.deps);

    assert.deepEqual(run.calls, ['read main-stage', 'confirm']);
    const request = run.asked();
    assert.ok(request);
    assert.match(
      String(request.body),
      /live broadcast on main-stage pauses until the uploader has written its recording and restarted, which takes seconds for a short broadcast and up to about five minutes for a long one, and keeps the recording\./,
    );
    assert.equal(request.confirmLabel, 'Apply now');

    await request.onConfirm();
    assert.deepEqual(run.calls.slice(2), [
      'apply main-stage 00000000-0000-4000-8000-000000000001',
      'done ["stream-uploader"]',
    ]);
  });

  it('still asks first when SRS reported nobody, saying a publisher that connected moments ago would not show yet', async () => {
    const run = harness(IDLE);

    await applyNow(uploader(), run.deps);

    assert.deepEqual(run.calls, ['read main-stage', 'confirm']);
    assert.match(
      run.asked()?.body ?? '',
      /SRS reported no publisher on main-stage in its last window, but it reports one only about every ten seconds, so a publisher that connected moments ago would not show yet\. If one is live, it pauses until the uploader has written its recording and restarted, which takes seconds for a short broadcast and up to about five minutes for a long one, and keeps the recording\./,
    );
  });

  it('gives up on an ingest read that does not answer in time, and asks as when it cannot tell', async () => {
    const run = harness('stalls');

    await applyNow(uploader(), run.deps);

    assert.deepEqual(run.calls, ['read main-stage', 'confirm']);
    assert.match(
      run.asked()?.body ?? '',
      /cannot tell whether a broadcast is live on main-stage\. If one is, it pauses until the uploader has written its recording and restarted, which takes seconds for a short broadcast and up to about five minutes for a long one/,
    );
  });

  it('asks first when it cannot tell, and says so', async () => {
    const run = harness(new Error('the manager did not answer'));

    await applyNow(stage(), run.deps);

    assert.deepEqual(run.calls, ['read stage-a', 'confirm']);
    assert.match(String(run.asked()?.body), /cannot tell whether a broadcast is live on stage-a/);
  });

  it('asks first when it applies more than the batch, even with nobody publishing, naming what else', async () => {
    const run = harness(IDLE);

    await applyNow(uploader({ changedKeys: ['STAMP', 'LOG_LEVEL'] }), run.deps);

    assert.deepEqual(run.calls, ['read main-stage', 'confirm']);
    const request = run.asked();
    assert.ok(request);
    assert.equal(request.title, 'Apply every saved setting on main-stage?');
    assert.match(request.body, /It also applies LOG_LEVEL, saved earlier and not applied yet, not only the batch\./);
  });

  it('says a live broadcast stops until the encoder reconnects when SRS is recreated too, and the restart waits for the recording', async () => {
    const run = harness(LIVE);

    await applyNow(
      uploader({ recreates: ['srs', 'stream-uploader'], changedKeys: ['STAMP', 'SRT_LATENCY'] }),
      run.deps,
    );

    const body = run.asked()?.body ?? '';
    assert.match(body, /This recreates srs and stream-uploader, so the encoder is disconnected and has to reconnect\./);
    assert.match(
      body,
      /The live broadcast on main-stage stops until the encoder reconnects, and the restart waits until the uploader has written its recording, which takes seconds for a short broadcast and up to about five minutes for a long one, and keeps the recording\./,
    );
    assert.doesNotMatch(body, /a few seconds/);
  });

  it('says every service is redeployed when a changed key reaches the deploy scripts alone', async () => {
    const run = harness(new Error('no answer'));

    await applyNow(uploader({ recreates: 'all', changedKeys: ['STAMP', 'COMPOSE_NETWORK'] }), run.deps);

    const body = run.asked()?.body ?? '';
    assert.match(
      body,
      /This redeploys every service of main-stage, so the encoder is disconnected and has to reconnect\./,
    );
    assert.match(
      body,
      /cannot tell whether a broadcast is live on main-stage\. If one is, it stops until the encoder reconnects, and the restart waits until the uploader has written its recording, which takes seconds for a short broadcast and up to about five minutes for a long one, and keeps the recording\./,
    );
  });
});

describe('the settings are read again the moment a Use lands', () => {
  it('stores the batch first, then reads the deployments and the uploaders again', async () => {
    const calls: string[] = [];

    await setBatchAndReread(NEW, {
      setStamp: async (batchId) => {
        calls.push(`set ${batchId}`);
      },
      reloadDeployments: () => {
        calls.push('deployments');
      },
      rereadUploaders: async () => {
        calls.push('uploaders');
      },
    });

    assert.deepEqual(calls, [`set ${NEW}`, 'deployments', 'uploaders']);
  });

  it('reads nothing again when the Use was refused', async () => {
    const calls: string[] = [];

    await assert.rejects(
      setBatchAndReread(NEW, {
        setStamp: async () => {
          throw new Error('refused');
        },
        reloadDeployments: () => {
          calls.push('deployments');
        },
        rereadUploaders: async () => {
          calls.push('uploaders');
        },
      }),
      /refused/,
    );
    assert.deepEqual(calls, []);
  });

  it("re-reads a stage's list when it is removed and created again under the same name", () => {
    const stage: Parameters<typeof stageReadKey>[0][number] = {
      name: 'stage-a',
      instance_id: 'one',
      status: 'RUNNING',
      stamp_id: null,
      bee_publishers: publishers(NEW),
    };

    assert.notEqual(stageReadKey([stage]), stageReadKey([{ ...stage, instance_id: 'two' }]));
    assert.equal(stageReadKey([stage]), stageReadKey([{ ...stage }]));
  });

  it("re-reads a deployment's own list when its batch or its pool string moves, not only its status", () => {
    const base: Pick<Profile, 'status' | 'stamp_id' | 'bee_publishers'> = {
      status: 'RUNNING',
      stamp_id: OLD,
      bee_publishers: null,
    };

    assert.notEqual(settingsReadKey(base), settingsReadKey({ ...base, stamp_id: NEW }));
    assert.notEqual(settingsReadKey(base), settingsReadKey({ ...base, bee_publishers: publishers(NEW) }));
    assert.notEqual(settingsReadKey(base), settingsReadKey({ ...base, status: 'DEPLOYING' }));
    assert.equal(settingsReadKey(base), settingsReadKey({ ...base }));
  });
});

describe("the stages' settings lists after a Use", () => {
  it('shows the stages that answered when another does not answer in time', async () => {
    const read = async (name: string) => {
      if (name === 'stage-stalled') return new Promise<DeploymentSettingsCatalog>(() => undefined);
      return catalog([entry({ key: 'BEE_PUBLISHERS', value: publishers(NEW) })]);
    };

    const answered = await readStageCatalogs(['stage-a', 'stage-stalled', 'stage-b'], read, 20);

    assert.deepEqual(
      answered.map(({ name }) => name),
      ['stage-a', 'stage-b'],
    );
  });

  it('hands each read a signal that aborts at its deadline', async () => {
    let aborted = false;
    const read = async (_name: string, signal: AbortSignal) =>
      new Promise<DeploymentSettingsCatalog>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });

    assert.deepEqual(await readStageCatalogs(['stage-a'], read, 20), []);
    assert.equal(aborted, true);
  });
});
