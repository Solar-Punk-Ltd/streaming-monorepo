/**
 * StageRepository and CatalogueStampRepository against the real database (migrations 009 and 010), and the stage
 * service over them with the audit log in Postgres. Needs Postgres, like the rest of this suite; `DATABASE_URL`
 * overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that an older record is kept out by the upsert itself, that a retired
 * stage comes back only for a record observed after the retirement arrived (by the database's clock), that a list
 * never selects the passphrase or the token hash, and the CHECKs that keep both out of the stored record. And that
 * the audit log takes the manager as an actor (migration 009 widens its CHECK).
 *
 * Every row it writes is in the suite's throwaway database; it empties both tables before each test.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { PostgresAuditLog } from '../../src/domain/PostgresAuditLog.js';
import { CatalogueStampRepository, StageRepository } from '../../src/domain/StageRepository.js';
import { splitStageRecord, StageService } from '../../src/domain/StageService.js';
import {
  catalogueStampRecord,
  SRT_PASSPHRASE,
  STAGE_ID,
  stageRecord,
  TOKEN_SHA256,
} from '../unit/support/stageFakes.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let stages: StageRepository;
let catalogue: CatalogueStampRepository;

/** An ISO moment `seconds` from now, by this process's clock, which shares a host with the database here. */
function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  stages = new StageRepository(database.pool);
  catalogue = new CatalogueStampRepository(database.pool);
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM stages');
  await database.pool.query('DELETE FROM catalogue_stamp');
  await database.pool.query(`DELETE FROM audit_log WHERE actor_kind = 'manager'`);
});

describe('StageRepository', () => {
  it('stores a record without the passphrase and the token, which have columns of their own', async () => {
    const written = await stages.upsert(splitStageRecord(stageRecord()));

    assert.ok(written);
    assert.equal(written.stage_id, STAGE_ID);
    assert.equal(written.has_srt_passphrase, true);
    assert.equal(written.admin_token_kind, 'shared');
    assert.equal(written.retired_at, null);
    assert.equal('srt_passphrase' in written, false);
    assert.equal('admin_token_sha256' in written, false);

    const raw = await database.pool.query<{ record: unknown; srt_passphrase: string; admin_token_sha256: string }>(
      'SELECT record, srt_passphrase, admin_token_sha256 FROM stages WHERE stage_id = $1',
      [STAGE_ID],
    );
    assert.equal(raw.rows[0]?.srt_passphrase, SRT_PASSPHRASE);
    assert.equal(raw.rows[0]?.admin_token_sha256, TOKEN_SHA256);
    assert.doesNotMatch(JSON.stringify(raw.rows[0]?.record), new RegExp(`${SRT_PASSPHRASE}|${TOKEN_SHA256}`));

    const found = await stages.find(STAGE_ID);
    assert.equal(found?.srt_passphrase, SRT_PASSPHRASE);
    assert.equal(found?.admin_token_sha256, TOKEN_SHA256);
  });

  it('lists without selecting the passphrase or the token hash, active stages first', async () => {
    const other = '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60';
    await stages.upsert(splitStageRecord(stageRecord({ name: 'B stage' })));
    await stages.upsert(splitStageRecord(stageRecord({ stageId: other, name: 'A stage', adminToken: null })));
    await stages.retire(other);

    const listed = await stages.list();

    assert.deepEqual(
      listed.map((row) => [row.name, row.retired_at === null]),
      [
        ['B stage', true],
        ['A stage', false],
      ],
    );
    for (const row of listed) {
      assert.equal('srt_passphrase' in row, false);
      assert.equal('admin_token_sha256' in row, false);
    }
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(`${SRT_PASSPHRASE}|${TOKEN_SHA256}`));
  });

  it('keeps a newer record out of reach of an older one, and stores a repeat', async () => {
    await stages.upsert(splitStageRecord(stageRecord({ observedAt: '2026-09-28T10:01:00.000Z', status: 'running' })));

    const older = await stages.upsert(
      splitStageRecord(stageRecord({ observedAt: '2026-09-28T10:00:00.000Z', status: 'stopped' })),
    );
    const repeat = await stages.upsert(
      splitStageRecord(stageRecord({ observedAt: '2026-09-28T10:01:00.000Z', status: 'running' })),
    );

    assert.equal(older, null);
    assert.ok(repeat);
    assert.equal((await stages.find(STAGE_ID))?.record.status, 'running');
  });

  it('retires once, and brings a stage back only for a record observed after the retirement', async () => {
    await stages.upsert(splitStageRecord(stageRecord({ observedAt: secondsFromNow(-120) })));

    assert.ok(await stages.retire(STAGE_ID));
    assert.equal(await stages.retire(STAGE_ID), null);
    assert.equal(await stages.retire('ffffffff-ffff-4fff-8fff-ffffffffffff'), null);

    const inFlight = await stages.upsert(splitStageRecord(stageRecord({ observedAt: secondsFromNow(-60) })));
    assert.ok(inFlight, 'stored: it is newer than the stored record');
    assert.ok(inFlight.retired_at instanceof Date, 'but the stage stays retired');

    const back = await stages.upsert(splitStageRecord(stageRecord({ observedAt: secondsFromNow(60) })));
    assert.equal(back?.retired_at, null);
  });

  it('refuses a record that carries the passphrase or the token, and a token hash without its kind', async () => {
    const record = JSON.stringify(stageRecord());
    const insert = (recordJson: string, hash: string | null, kind: string | null) =>
      database.pool.query(
        `INSERT INTO stages (stage_id, manager_id, name, kind, engine, owner, record, admin_token_sha256, admin_token_kind, observed_at)
         VALUES ($1, $2, 'x', 'abr-uploader', 'srs', $3, $4::jsonb, $5, $6, NOW())`,
        [STAGE_ID, stageRecord().managerId, stageRecord().owner, recordJson, hash, kind],
      );

    await assert.rejects(insert(record, null, null), { code: '23514' }, 'the whole record, passphrase and token');
    const { adminToken: _token, ...withoutToken } = stageRecord();
    await assert.rejects(insert(JSON.stringify(withoutToken), null, null), { code: '23514' }, 'the passphrase');
    const stored = JSON.stringify(splitStageRecord(stageRecord()).record);
    await assert.rejects(insert(stored, TOKEN_SHA256, null), { code: '23514' }, 'a hash without its kind');
    await assert.rejects(insert(stored, null, 'own'), { code: '23514' }, 'a kind without its hash');
  });
});

describe('CatalogueStampRepository', () => {
  it('holds one row, which an older record does not replace', async () => {
    assert.equal(await catalogue.get(), null);

    await catalogue.upsert(catalogueStampRecord({ observedAt: '2026-09-28T10:01:00.000Z' }));
    const older = await catalogue.upsert(catalogueStampRecord({ observedAt: '2026-09-28T10:00:00.000Z' }));
    const next = await catalogue.upsert(
      catalogueStampRecord({ batchId: 'd3'.repeat(32), observedAt: '2026-09-28T10:02:00.000Z' }),
    );

    assert.equal(older, null);
    assert.equal(next?.batch_id, 'd3'.repeat(32));
    assert.equal(next?.record.beeApiUrl, catalogueStampRecord().beeApiUrl);
    const count = await database.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM catalogue_stamp');
    assert.equal(count.rows[0]?.n, 1);
    await assert.rejects(
      database.pool.query(
        `INSERT INTO catalogue_stamp (id, manager_id, batch_id, record, observed_at)
         VALUES (FALSE, $1, 'x', '{}'::jsonb, NOW())`,
        [catalogueStampRecord().managerId],
      ),
      { code: '23514' },
      'a second row',
    );
  });

  it('clears once, and a record observed before the clear leaves it cleared', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: secondsFromNow(-120) }));

    assert.ok(await catalogue.clear());
    assert.equal(await catalogue.clear(), null);

    const inFlight = await catalogue.upsert(catalogueStampRecord({ observedAt: secondsFromNow(-60) }));
    assert.ok(inFlight?.cleared_at instanceof Date);

    const again = await catalogue.upsert(catalogueStampRecord({ observedAt: secondsFromNow(60) }));
    assert.equal(again?.cleared_at, null);
  });
});

describe('StageService over Postgres', () => {
  it('writes the manager into the audit log with no name, and no secret in the details', async () => {
    const service = new StageService(stages, catalogue, new PostgresAuditLog(database.pool));

    await service.store(stageRecord());
    await service.store(
      stageRecord({
        observedAt: '2026-09-28T10:00:30.000Z',
        ingest: { ...stageRecord().ingest, srtPassphrase: 'a-new-passphrase' },
      }),
    );
    await service.retire(STAGE_ID);
    await service.storeCatalogueStamp(catalogueStampRecord());

    const rows = await database.pool.query<{ actor_kind: string; actor_name: string | null; action: string }>(
      `SELECT actor_kind, actor_name, action, details FROM audit_log WHERE actor_kind = 'manager' ORDER BY id`,
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.actor_kind, row.actor_name, row.action]),
      [
        ['manager', null, 'stage.register'],
        ['manager', null, 'stage.change'],
        ['manager', null, 'stage.retire'],
        ['manager', null, 'catalogue.stamp.set'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(rows.rows), new RegExp(`${SRT_PASSPHRASE}|a-new-passphrase|${TOKEN_SHA256}`));
  });
});
