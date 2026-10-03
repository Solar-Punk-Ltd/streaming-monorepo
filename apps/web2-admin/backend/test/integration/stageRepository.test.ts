/**
 * StageRepository and CatalogueStampRepository against the real database (migrations 009 and 010), and the stage
 * service over them with the audit log in Postgres. Needs Postgres, like the rest of this suite; `DATABASE_URL`
 * overrides the connection.
 *
 * What a fake cannot stand in for is the SQL: that an older record is kept out by the upsert itself; that a
 * retirement is ordered by the manager's moment and never by the database's clock, is not taken against a record
 * observed after it, and is kept for a stage never stored so a late first push cannot register it; that a list never
 * selects the passphrase or the token hash; and the CHECKs that keep both out of the stored record. And that the audit
 * log takes the manager as an actor (migration 009 widens its CHECK).
 *
 * The manager's moments here are in 2030, far from the database's clock, so a rule that used the latter would fail.
 * Every row it writes is in the suite's throwaway database; it empties the tables before each test.
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

const UNKNOWN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A manager's moment on a day the database's clock is nowhere near. */
const at = (time: string) => `2030-01-01T${time}.000Z`;

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
  await database.pool.query('DELETE FROM stage_retirements');
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
    assert.equal(written.retired_observed_at, null);
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
    await stages.retire(other, at('10:05:00'));

    const listed = await stages.list();

    assert.deepEqual(
      listed.map((row) => [row.name, row.retired_observed_at === null]),
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

  it('retires as of the manager’s moment, and brings a stage back only for a record observed after it', async () => {
    await stages.upsert(splitStageRecord(stageRecord({ observedAt: at('10:00:00') })));

    const done = await stages.retire(STAGE_ID, at('10:05:00'));
    assert.equal(done.outcome, 'done');
    assert.equal((await stages.retire(STAGE_ID, at('10:05:30'))).outcome, 'already');
    const row = await stages.find(STAGE_ID);
    assert.equal(row?.retired_observed_at?.toISOString(), at('10:05:30'), 'a second retirement keeps the later moment');
    assert.ok(row?.retired_at instanceof Date, 'and when it arrived is kept beside it');

    const inFlight = await stages.upsert(splitStageRecord(stageRecord({ observedAt: at('10:05:10') })));
    assert.ok(inFlight, 'stored: it is newer than the stored record');
    assert.ok(inFlight.retired_observed_at instanceof Date, 'but the stage stays retired');

    const back = await stages.upsert(splitStageRecord(stageRecord({ observedAt: at('10:06:00') })));
    assert.equal(back?.retired_observed_at, null);
    assert.equal(back?.retired_at, null);
  });

  it('does not take a retirement older than the record it holds', async () => {
    await stages.upsert(splitStageRecord(stageRecord({ observedAt: at('10:05:00') })));

    assert.equal((await stages.retire(STAGE_ID, at('10:04:00'))).outcome, 'newer');
    assert.equal((await stages.find(STAGE_ID))?.retired_observed_at, null);
  });

  it('keeps the retirement of a stage never stored, and a record observed after it replaces it', async () => {
    assert.equal((await stages.retire(UNKNOWN, at('10:05:00'))).outcome, 'unknown');
    assert.equal((await stages.retire(UNKNOWN, at('10:04:00'))).outcome, 'unknown');
    const kept = await database.pool.query<{ observed_at: Date }>(
      'SELECT observed_at FROM stage_retirements WHERE stage_id = $1',
      [UNKNOWN],
    );
    assert.equal(kept.rows[0]?.observed_at.toISOString(), at('10:05:00'), 'the later moment is kept');

    for (const time of ['10:04:30', '10:05:00']) {
      const late = await stages.upsert(splitStageRecord(stageRecord({ stageId: UNKNOWN, observedAt: at(time) })));
      assert.equal(late, null, time);
    }
    assert.equal(await stages.find(UNKNOWN), null);

    const registered = await stages.upsert(
      splitStageRecord(stageRecord({ stageId: UNKNOWN, observedAt: at('10:06:00') })),
    );
    assert.equal(registered?.stage_id, UNKNOWN);
    assert.equal(registered?.retired_observed_at, null);
    const left = await database.pool.query('SELECT 1 FROM stage_retirements WHERE stage_id = $1', [UNKNOWN]);
    assert.equal(left.rowCount, 0, 'storing the record forgets the retirement');
  });

  it('refuses a record that carries the passphrase or the token, a token hash without its kind, and half a retirement', async () => {
    const record = JSON.stringify(stageRecord());
    const insert = (
      recordJson: string,
      hash: string | null,
      kind: string | null,
      retiredObservedAt: string | null = null,
    ) =>
      database.pool.query(
        `INSERT INTO stages (stage_id, manager_id, name, kind, engine, owner, record, admin_token_sha256, admin_token_kind,
                             observed_at, retired_observed_at)
         VALUES ($1, $2, 'x', 'abr-uploader', 'srs', $3, $4::jsonb, $5, $6, NOW(), $7)`,
        [STAGE_ID, stageRecord().managerId, stageRecord().owner, recordJson, hash, kind, retiredObservedAt],
      );

    await assert.rejects(insert(record, null, null), { code: '23514' }, 'the whole record, passphrase and token');
    const { adminToken: _token, ...withoutToken } = stageRecord();
    await assert.rejects(insert(JSON.stringify(withoutToken), null, null), { code: '23514' }, 'the passphrase');
    const stored = JSON.stringify(splitStageRecord(stageRecord()).record);
    await assert.rejects(insert(stored, TOKEN_SHA256, null), { code: '23514' }, 'a hash without its kind');
    await assert.rejects(insert(stored, null, 'own'), { code: '23514' }, 'a kind without its hash');
    await assert.rejects(insert(stored, null, null, at('10:00:00')), { code: '23514' }, 'a moment without arrival');
  });
  it('finds a stage by its own token’s sha256: active, own-kind rows only, and two at most', async () => {
    const own = 'ab'.repeat(32);
    const twice = 'cd'.repeat(32);
    const ids = {
      own: STAGE_ID,
      shared: '6a1d3b9f-2c3d-4e5f-8a51-1b2c3d4e5f60',
      retired: '7b2e4c0a-3d4e-4f60-9b62-2c3d4e5f6071',
      twiceA: '9d406e2c-5f60-4182-9d84-4e5f60718293',
      twiceB: 'ae517f3d-6071-4293-8e95-5f60718293a4',
      twiceC: 'bf6280e4-7182-43a4-9fa6-60718293a4b5',
    };
    const push = (stageId: string, name: string, sha256: string, kind: 'own' | 'shared') =>
      stages.upsert(splitStageRecord(stageRecord({ stageId, name, adminToken: { sha256, kind } })));
    await push(ids.own, 'Own stage', own, 'own');
    // The same hash on a `shared` row, and on a retired stage: neither is found by it.
    await push(ids.shared, 'Shared stage', own, 'shared');
    await push(ids.retired, 'Retired stage', own, 'own');
    await stages.retire(ids.retired, at('10:05:00'));
    await push(ids.twiceA, 'Twice A', twice, 'own');
    await push(ids.twiceB, 'Twice B', twice, 'own');
    await push(ids.twiceC, 'Twice C', twice, 'own');

    const found = await stages.findActiveByOwnTokenSha256(own);
    assert.deepEqual(
      found.map((row) => [row.stage_id, row.name, row.owner, row.admin_token_kind]),
      [[ids.own, 'Own stage', stageRecord().owner, 'own']],
    );
    assert.equal('admin_token_sha256' in found[0]!, false, 'the hash is not selected');
    assert.doesNotMatch(JSON.stringify(found), new RegExp(own));

    assert.deepEqual(
      (await stages.findActiveByOwnTokenSha256(twice)).map((row) => row.stage_id),
      [ids.twiceA, ids.twiceB],
      'several stages on one token come back, two at most',
    );
    assert.deepEqual(await stages.findActiveByOwnTokenSha256('ef'.repeat(32)), []);

    // A stage's own token is taken no more once the stage is retired.
    await stages.retire(ids.own, at('10:05:00'));
    assert.deepEqual(await stages.findActiveByOwnTokenSha256(own), []);
  });

  it('defines the lookup’s index: partial to own-kind active rows, not unique (migration 012)', async () => {
    const index = await database.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'stages' AND indexname = 'stages_own_admin_token_idx'`,
    );
    const definition = index.rows[0]?.indexdef ?? '';
    assert.match(definition, /\(admin_token_sha256\)/);
    assert.match(definition, /admin_token_kind = 'own'/);
    assert.match(definition, /retired_observed_at IS NULL/);
    assert.doesNotMatch(definition, /UNIQUE/);
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
    assert.equal(next?.record?.beeApiUrl, catalogueStampRecord().beeApiUrl);
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

  it('clears as of the manager’s moment, and sets it again only for a record observed after it', async () => {
    await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:00:00') }));

    assert.equal((await catalogue.clear(at('09:59:00'))).outcome, 'newer', 'older than the record: not taken');
    assert.equal((await catalogue.clear(at('10:05:00'))).outcome, 'done');
    assert.equal((await catalogue.clear(at('10:05:30'))).outcome, 'already');

    const inFlight = await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:05:10') }));
    assert.ok(inFlight?.cleared_observed_at instanceof Date, 'a record from before the later clear leaves it cleared');

    const again = await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:06:00') }));
    assert.equal(again?.cleared_observed_at, null);
    assert.equal(again?.cleared_at, null);
  });

  it('keeps a clear that arrives before any record, and only a record observed after it sets the stamp', async () => {
    assert.equal((await catalogue.clear(at('10:05:00'))).outcome, 'unknown');
    const row = await catalogue.get();
    assert.equal(row?.record, null);
    assert.equal(row?.cleared_observed_at?.toISOString(), at('10:05:00'));

    assert.equal(await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:04:00') })), null);
    assert.equal(await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:05:00') })), null);

    const set = await catalogue.upsert(catalogueStampRecord({ observedAt: at('10:06:00') }));
    assert.equal(set?.batch_id, catalogueStampRecord().batchId);
    assert.equal(set?.cleared_observed_at, null);
  });

  it('refuses a row with no record and no clear', async () => {
    await assert.rejects(database.pool.query(`INSERT INTO catalogue_stamp (id, observed_at) VALUES (TRUE, NOW())`), {
      code: '23514',
    });
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
    await service.retire(STAGE_ID, '2026-09-28T10:05:00.000Z');
    await service.storeCatalogueStamp(catalogueStampRecord());
    await service.clearCatalogueStamp('2026-09-28T10:05:00.000Z');

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
        ['manager', null, 'catalogue.stamp.clear'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(rows.rows), new RegExp(`${SRT_PASSPHRASE}|a-new-passphrase|${TOKEN_SHA256}`));
  });
});
