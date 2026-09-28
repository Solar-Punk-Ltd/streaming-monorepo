/**
 * The stage service: what the manager's pushes store, what they are refused, and which of them leave an audit row.
 * Unit test, with the stores and the audit log in memory. `pnpm test`.
 *
 * A push arrives every 30 seconds per stage and almost always repeats the last one, so what is pinned here is that
 * only a registration, a retirement, a return and a change to the owner, the ingest details or the token is audited,
 * that an older record never replaces a newer one, and that neither the passphrase nor the token hash reaches an audit
 * row or a log line.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import { MANAGER } from '../../src/domain/actor.js';
import type { AuditEntry } from '../../src/domain/AuditLog.js';
import { StageService, splitStageRecord } from '../../src/domain/StageService.js';

import { InMemoryAuditLog } from './support/fakes.js';
import {
  CATALOGUE_BATCH_ID,
  catalogueStampRecord,
  FakeCatalogueStampStore,
  FakeStageStore,
  SRT_PASSPHRASE,
  STAGE_ID,
  stageRecord,
  TestClock,
  TOKEN_SHA256,
} from './support/stageFakes.js';

let clock: TestClock;
let stages: FakeStageStore;
let catalogue: FakeCatalogueStampStore;
let audit: InMemoryAuditLog;
let service: StageService;

/** Every line the service logged while `run` ran, at any level. */
async function logged(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  const methods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => mock.method(console, name, keep));
  try {
    await run();
  } finally {
    for (const method of methods) method.mock.restore();
  }
  return lines;
}

/** The details of an audit entry that has to exist, typed as the test reads them. */
function detailsOf<T>(entry: AuditEntry | undefined): T {
  assert.ok(entry?.details, 'no audit entry, or one without details');
  return entry.details as T;
}

beforeEach(() => {
  clock = new TestClock();
  stages = new FakeStageStore(clock);
  catalogue = new FakeCatalogueStampStore(clock);
  audit = new InMemoryAuditLog();
  service = new StageService(stages, catalogue, audit);
});

describe('splitStageRecord', () => {
  it('takes the passphrase and the token out of the record it keeps', () => {
    const write = splitStageRecord(stageRecord());

    assert.equal(write.srtPassphrase, SRT_PASSPHRASE);
    assert.deepEqual(write.adminToken, { sha256: TOKEN_SHA256, kind: 'shared' });
    assert.equal('adminToken' in write.record, false);
    assert.equal('srtPassphrase' in write.record.ingest, false);
    assert.doesNotMatch(JSON.stringify(write.record), new RegExp(`${SRT_PASSPHRASE}|${TOKEN_SHA256}`));
  });
});

describe('StageService.store', () => {
  it('registers a stage it has not seen, with one audit row that names the manager', async () => {
    const lines = await logged(() => service.store(stageRecord()));

    assert.equal(stages.rows.get(STAGE_ID)?.srt_passphrase, SRT_PASSPHRASE);
    const [entry, ...rest] = audit.entries;
    assert.equal(rest.length, 0);
    assert.equal(entry?.action, 'stage.register');
    assert.deepEqual(entry?.actor, MANAGER);
    const details = detailsOf<{ stageId: string; ingest: { hasSrtPassphrase: boolean } }>(entry);
    assert.equal(details.stageId, STAGE_ID);
    assert.equal(details.ingest.hasSrtPassphrase, true);
    assert.ok(lines.some((line) => line.includes('[INFO]') && line.includes('the manager registered stage')));
  });

  it('answers stored for a repeat observed at the same moment, and audits nothing more', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;

    const lines = await logged(async () => assert.deepEqual(await service.store(stageRecord()), { stored: true }));

    assert.equal(audit.entries.length, 0);
    assert.ok(
      lines.every((line) => line.includes('[DEBUG]')),
      'an unchanged push logs at debug only',
    );
  });

  it('keeps the newer record when an older one arrives', async () => {
    await service.store(stageRecord({ observedAt: '2026-09-28T10:01:00.000Z', status: 'running' }));
    audit.entries.length = 0;

    const answer = await service.store(
      stageRecord({ observedAt: '2026-09-28T10:00:30.000Z', status: 'stopped', owner: `0x${'11'.repeat(20)}` }),
    );

    assert.deepEqual(answer, { stored: false });
    const row = stages.rows.get(STAGE_ID)!;
    assert.equal(row.record.status, 'running');
    assert.equal(row.observed_at.toISOString(), '2026-09-28T10:01:00.000Z');
    assert.equal(audit.entries.length, 0);
  });

  it('stores a newer record that moves only readings, and audits nothing', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;

    const answer = await service.store(
      stageRecord({
        observedAt: '2026-09-28T10:00:30.000Z',
        name: 'Main stage, renamed',
        status: 'degraded',
        readiness: { tone: 'warning', reasons: ['720p: the batch has less than two days left'] },
        rungs: [],
        uploader: null,
      }),
    );

    assert.deepEqual(answer, { stored: true });
    assert.equal(stages.rows.get(STAGE_ID)?.record.readiness.tone, 'warning');
    assert.equal(audit.entries.length, 0);
  });

  it('audits a change of owner and ingest details with both values', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;
    const owner = `0x${'22'.repeat(20)}`;

    await service.store(
      stageRecord({
        observedAt: '2026-09-28T10:00:30.000Z',
        owner,
        ingest: { ...stageRecord().ingest, host: 'ingest-2.example.org', srtPort: 10071 },
      }),
    );

    const [entry] = audit.withAction('stage.change');
    assert.deepEqual(detailsOf<{ changes: unknown }>(entry).changes, {
      owner: { from: stageRecord().owner, to: owner },
      'ingest.host': { from: 'ingest.example.org', to: 'ingest-2.example.org' },
      'ingest.srtPort': { from: 10061, to: 10071 },
    });
  });

  it('says the passphrase and the token changed, never what they are', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;
    const newPassphrase = 'another-passphrase-do-not-print';
    const newHash = 'bb'.repeat(32);

    const lines = await logged(() =>
      service.store(
        stageRecord({
          observedAt: '2026-09-28T10:00:30.000Z',
          ingest: { ...stageRecord().ingest, srtPassphrase: newPassphrase },
          adminToken: { sha256: newHash, kind: 'own' },
        }),
      ),
    );

    const [entry, ...rest] = audit.entries;
    assert.equal(rest.length, 0);
    assert.equal(entry?.action, 'stage.change');
    assert.deepEqual(detailsOf<{ changes: unknown }>(entry).changes, {
      'ingest.srtPassphrase': 'changed',
      adminToken: 'changed',
      adminTokenKind: { from: 'shared', to: 'own' },
    });
    const everything = JSON.stringify(audit.entries) + lines.join('\n');
    for (const secret of [SRT_PASSPHRASE, newPassphrase, TOKEN_SHA256, newHash]) {
      assert.equal(everything.includes(secret), false, 'a secret reached an audit row or a log line');
    }
    assert.ok(lines.some((line) => line.includes('passphrase changed') && line.includes('uploader token changed')));
  });

  it('says a passphrase was removed, and set again', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;

    await service.store(
      stageRecord({ observedAt: '2026-09-28T10:00:30.000Z', ingest: { ...stageRecord().ingest, srtPassphrase: null } }),
    );
    await service.store(stageRecord({ observedAt: '2026-09-28T10:01:00.000Z' }));

    assert.deepEqual(
      audit.entries.map((entry) => (entry.details as { changes: unknown }).changes),
      [{ 'ingest.srtPassphrase': 'removed' }, { 'ingest.srtPassphrase': 'set' }],
    );
  });

  it('answers the store as done when the audit write fails', async () => {
    audit.failNextWrite = new Error('connection lost');

    const lines = await logged(async () => assert.deepEqual(await service.store(stageRecord()), { stored: true }));

    assert.ok(stages.rows.has(STAGE_ID));
    assert.ok(lines.some((line) => line.includes('[Audit] could not record stage.register')));
  });
});

describe('StageService.retire', () => {
  it('retires a stage once and keeps its row', async () => {
    await service.store(stageRecord());
    audit.entries.length = 0;

    assert.deepEqual(await service.retire(STAGE_ID), { retired: true });
    assert.deepEqual(await service.retire(STAGE_ID), { retired: false });

    const [listed] = await service.list();
    assert.equal(listed?.stage_id, STAGE_ID);
    assert.ok(listed?.retired_at instanceof Date);
    assert.deepEqual(
      audit.entries.map((entry) => [entry.action, entry.details]),
      [['stage.retire', { stageId: STAGE_ID, name: 'Main stage' }]],
    );
  });

  it('answers false for a stage it never heard of, and audits nothing', async () => {
    assert.deepEqual(await service.retire('ffffffff-ffff-4fff-8fff-ffffffffffff'), { retired: false });
    assert.equal(audit.entries.length, 0);
  });

  it('brings a retired stage back for a record observed after the retirement', async () => {
    await service.store(stageRecord());
    clock.set('2026-09-28T10:05:00.000Z');
    await service.retire(STAGE_ID);
    audit.entries.length = 0;

    const answer = await service.store(stageRecord({ observedAt: '2026-09-28T10:06:00.000Z' }));

    assert.deepEqual(answer, { stored: true });
    assert.equal(stages.rows.get(STAGE_ID)?.retired_at, null);
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['stage.unretire'],
    );
  });

  it('leaves it retired for a push that was on its way when the stage was retired', async () => {
    await service.store(stageRecord());
    clock.set('2026-09-28T10:05:00.000Z');
    await service.retire(STAGE_ID);
    audit.entries.length = 0;

    const answer = await service.store(stageRecord({ observedAt: '2026-09-28T10:04:30.000Z' }));

    assert.deepEqual(answer, { stored: true }, 'the record is newer than the stored one, so it is stored');
    assert.ok(stages.rows.get(STAGE_ID)?.retired_at instanceof Date, 'but the stage stays retired');
    assert.equal(audit.entries.length, 0);
  });
});

describe('StageService catalogue stamp', () => {
  it('is null until the manager sets it', async () => {
    assert.equal(await service.catalogueStamp(), null);
  });

  it('audits setting it, and not a repeat', async () => {
    assert.deepEqual(await service.storeCatalogueStamp(catalogueStampRecord()), { stored: true });
    assert.deepEqual(await service.storeCatalogueStamp(catalogueStampRecord()), { stored: true });

    assert.equal((await service.catalogueStamp())?.batch_id, CATALOGUE_BATCH_ID);
    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['catalogue.stamp.set'],
    );
    assert.equal(JSON.stringify(audit.entries).includes('192.0.2.10'), false, 'the Bee API address is not audited');
  });

  it('audits a batch change, and keeps a newer record over an older one', async () => {
    await service.storeCatalogueStamp(catalogueStampRecord());
    audit.entries.length = 0;
    const next = 'd3'.repeat(32);

    await service.storeCatalogueStamp(catalogueStampRecord({ batchId: next, observedAt: '2026-09-28T10:01:00.000Z' }));
    const older = await service.storeCatalogueStamp(catalogueStampRecord({ observedAt: '2026-09-28T10:00:30.000Z' }));

    assert.deepEqual(older, { stored: false });
    assert.equal((await service.catalogueStamp())?.batch_id, next);
    assert.deepEqual(
      audit.entries.map((entry) => [entry.action, entry.details]),
      [['catalogue.stamp.change', { batchId: { from: CATALOGUE_BATCH_ID, to: next } }]],
    );
  });

  it('clears it once, and sets it again only for a record observed after the clear', async () => {
    await service.storeCatalogueStamp(catalogueStampRecord());
    clock.set('2026-09-28T10:05:00.000Z');

    assert.deepEqual(await service.clearCatalogueStamp(), { cleared: true });
    assert.deepEqual(await service.clearCatalogueStamp(), { cleared: false });
    assert.equal(await service.catalogueStamp(), null);

    await service.storeCatalogueStamp(catalogueStampRecord({ observedAt: '2026-09-28T10:04:30.000Z' }));
    assert.equal(await service.catalogueStamp(), null, 'a push from before the clear does not undo it');

    await service.storeCatalogueStamp(catalogueStampRecord({ observedAt: '2026-09-28T10:06:00.000Z' }));
    assert.equal((await service.catalogueStamp())?.batch_id, CATALOGUE_BATCH_ID);

    assert.deepEqual(
      audit.entries.map((entry) => entry.action),
      ['catalogue.stamp.set', 'catalogue.stamp.clear', 'catalogue.stamp.set'],
    );
  });

  it('answers false for a clear when nothing was set', async () => {
    assert.deepEqual(await service.clearCatalogueStamp(), { cleared: false });
    assert.equal(audit.entries.length, 0);
  });
});
