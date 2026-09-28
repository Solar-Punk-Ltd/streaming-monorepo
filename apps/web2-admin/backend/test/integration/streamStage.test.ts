/**
 * A stream's stage against the real database: migration 011's column, its
 * foreign key and its index, and the SQL that holds the stage rules again
 * after the service has checked them. Needs Postgres, like the rest of this
 * suite; `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for: that the conditional UPDATE moves a stage
 * only while the row is a draft that does not hold both a recording and a
 * stage, and only to a stage the stages table holds, not retired, on SRS,
 * whatever the service read before it; that a save leaving the stage
 * alone, or naming the one the row has, passes on any status; that a stage
 * never moves `content_edited_at`; that the claim refuses a draft with no
 * stage when asked to; and that a stage id the stages table does not hold is
 * refused by the foreign key.
 *
 * Every row it writes is in the suite's throwaway database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { StageRepository } from '../../src/domain/StageRepository.js';
import { splitStageRecord } from '../../src/domain/StageService.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import { StreamRepository, type StreamUpdateData } from '../../src/domain/StreamRepository.js';
import { EDITABLE_STATUSES, type StreamRow } from '../../src/types/index.js';
import { stageRecord } from '../unit/support/stageFakes.js';

import { releaseStack, requireStack, stack } from './helpers.js';

const OWNER = '90f8bf6a479f320ead074411a4b0e7944ea8c9c1';

let database: Database;
let streams: StreamRepository;
let userId: string;
let stageA: string;
let stageB: string;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  streams = new StreamRepository(database.pool);
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  userId = user.rows[0]!.id;
  const stages = new StageRepository(database.pool);
  stageA = randomUUID();
  stageB = randomUUID();
  await stages.upsert(splitStageRecord(stageRecord({ stageId: stageA, name: 'Stage A' })));
  await stages.upsert(splitStageRecord(stageRecord({ stageId: stageB, name: 'Stage B' })));
});

after(async () => {
  if (database) await database.close();
  await releaseStack();
});

/** A draft on `stageId`, with `status` and a recording set by hand when a test needs them. */
async function stream(stageId: string | null, set: { status?: string; recording?: boolean } = {}): Promise<StreamRow> {
  const row = await streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: OWNER,
    title: 'itest stage',
    description: 'a stream on a stage',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
    stage_id: stageId,
  });
  if (set.status || set.recording) {
    await database.pool.query(
      `UPDATE streams
          SET status = COALESCE($2, status),
              manifest_index = CASE WHEN $3 THEN 7 ELSE manifest_index END,
              duration_seconds = CASE WHEN $3 THEN 61 ELSE duration_seconds END
        WHERE id = $1`,
      [row.id, set.status ?? null, set.recording ?? false],
    );
  }
  return (await streams.findById(row.id))!;
}

/** The form of `row` as it is, with the stage as given: absent leaves it. */
function form(row: StreamRow, stage?: string | null): StreamUpdateData {
  return {
    title: row.title,
    description: row.description,
    tags: row.tags,
    media_type: row.media_type,
    scheduled_start_time: null,
    ...(stage === undefined ? {} : { stage_id: stage }),
  };
}

describe('migration 011', () => {
  it('adds a nullable stage_id that references stages, with an index', async () => {
    const column = await database.pool.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'streams' AND column_name = 'stage_id'`,
    );
    assert.deepEqual(column.rows, [{ is_nullable: 'YES', data_type: 'uuid' }]);

    const index = await database.pool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'streams' AND indexname = 'streams_stage_id_idx'`,
    );
    assert.equal(index.rowCount, 1);
  });

  it('refuses a stage the stages table does not hold', async () => {
    await assert.rejects(() => stream(randomUUID()), /streams_stage_id_fkey/);
  });
});

describe('StreamRepository on stages', () => {
  it('stores the stage a stream is created on, and none', async () => {
    assert.equal((await stream(stageA)).stage_id, stageA);
    assert.equal((await stream(null)).stage_id, null);
  });

  it('moves a draft to another stage, and off it, without counting it as an edit', async () => {
    const row = await stream(stageA);

    const moved = await streams.update(row.id, form(row, stageB), EDITABLE_STATUSES);
    assert.equal(moved?.stage_id, stageB);
    assert.equal(moved?.content_edited_at, null, 'a stage is not on the catalogue entry');

    const cleared = await streams.update(row.id, form(row, null), EDITABLE_STATUSES);
    assert.equal(cleared?.stage_id, null);
  });

  it('refuses to move a draft to a stage that is retired, unsupported or not in the stages table', async () => {
    const stages = new StageRepository(database.pool);
    const retired = randomUUID();
    const ome = randomUUID();
    await stages.upsert(splitStageRecord(stageRecord({ stageId: retired, name: 'Stage R' })));
    assert.equal((await stages.retire(retired, '2099-01-01T00:00:00.000Z')).outcome, 'done');
    await stages.upsert(splitStageRecord(stageRecord({ stageId: ome, name: 'Stage O', engine: 'ome' })));
    const row = await stream(stageA);

    for (const target of [retired, ome, randomUUID()]) {
      assert.equal(await streams.update(row.id, form(row, target), EDITABLE_STATUSES), null, target);
    }
    assert.equal((await streams.findById(row.id))?.stage_id, stageA);
    assert.equal((await streams.update(row.id, form(row, stageB), EDITABLE_STATUSES))?.stage_id, stageB);
  });

  it('keeps a stream on its stage once that stage is retired, through a save that names it', async () => {
    const stages = new StageRepository(database.pool);
    const retiring = randomUUID();
    await stages.upsert(splitStageRecord(stageRecord({ stageId: retiring, name: 'Stage D' })));
    const row = await stream(retiring);
    await stages.retire(retiring, '2099-01-01T00:00:00.000Z');

    const saved = await streams.update(row.id, { ...form(row, retiring), title: 'Renamed' }, EDITABLE_STATUSES);
    assert.equal(saved?.title, 'Renamed');
    assert.equal(saved?.stage_id, retiring);
  });

  it('reads a stage summary without the passphrase or the token hash', async () => {
    const summary = await new StageRepository(database.pool).findSummary(stageA);

    assert.equal(summary?.stage_id, stageA);
    assert.equal(summary?.has_srt_passphrase, true);
    assert.ok(summary && !('srt_passphrase' in summary) && !('admin_token_sha256' in summary));
  });

  it('leaves the stage alone when the update does not name one', async () => {
    const row = await stream(stageA);

    assert.equal((await streams.update(row.id, form(row), EDITABLE_STATUSES))?.stage_id, stageA);
  });

  it('refuses to move a stream that is not a draft, and takes a save that keeps its stage', async () => {
    for (const status of ['published', 'live', 'vod']) {
      const row = await stream(stageA, { status, recording: status === 'vod' });

      assert.equal(await streams.update(row.id, form(row, stageB), EDITABLE_STATUSES), null, status);
      assert.equal(await streams.update(row.id, form(row, null), EDITABLE_STATUSES), null, status);
      assert.equal((await streams.findById(row.id))?.stage_id, stageA, status);
      assert.ok(await streams.update(row.id, { ...form(row, stageA), title: 'Renamed' }, EDITABLE_STATUSES), status);
    }
  });

  it('keeps the stage of a draft that holds a recording, and gives one without a stage its first', async () => {
    const recorded = await stream(stageA, { recording: true });
    assert.equal(await streams.update(recorded.id, form(recorded, stageB), EDITABLE_STATUSES), null);
    assert.equal((await streams.findById(recorded.id))?.stage_id, stageA);

    const older = await stream(null, { recording: true });
    assert.equal((await streams.update(older.id, form(older, stageA), EDITABLE_STATUSES))?.stage_id, stageA);
  });

  it('claims a draft with no stage for an unpublish, and not for a publish that needs one', async () => {
    const row = await stream(null);

    assert.equal(await streams.claimForPublish(row.id, ['draft', 'published'], true), null);
    assert.equal((await streams.findById(row.id))?.status, 'draft');

    assert.equal((await streams.claimForPublish(row.id, ['draft', 'published', 'vod']))?.status, 'publishing');
  });

  it('claims a draft on a stage for a publish that needs one', async () => {
    const row = await stream(stageA);

    assert.equal((await streams.claimForPublish(row.id, ['draft', 'published'], true))?.status, 'publishing');
  });

  it('keeps the stage of a stream when the stage is retired', async () => {
    const stages = new StageRepository(database.pool);
    const retiring = randomUUID();
    await stages.upsert(splitStageRecord(stageRecord({ stageId: retiring, name: 'Stage C' })));
    const row = await stream(retiring, { status: 'published' });

    assert.equal((await stages.retire(retiring, '2099-01-01T00:00:00.000Z')).outcome, 'done');
    assert.equal((await streams.findById(row.id))?.stage_id, retiring);
  });
});
