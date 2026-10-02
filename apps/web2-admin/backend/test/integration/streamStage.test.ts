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
/** Stage A signs as `OWNER`, printed the way a stage record prints it; stage B with a key of its own. */
const STAGE_A_OWNER = `0x${OWNER.toUpperCase()}`;
const STAGE_B_OWNER = '0x3f1a9c2b4d5e6f708192a3b4c5d6e7f809a1b2c3';
const ROTATED_OWNER = '0x4f0e1c2b3a49586772635441302f1e0d0c0b0a09';

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
  await stages.upsert(splitStageRecord(stageRecord({ stageId: stageA, name: 'Stage A', owner: STAGE_A_OWNER })));
  await stages.upsert(splitStageRecord(stageRecord({ stageId: stageB, name: 'Stage B', owner: STAGE_B_OWNER })));
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

  it('writes the owner an update names with a stage change, and never on a row that holds a recording', async () => {
    const row = await stream(stageA);
    const moved = await streams.update(row.id, { ...form(row, stageB), owner: 'b'.repeat(40) }, EDITABLE_STATUSES);
    assert.equal(moved?.owner, 'b'.repeat(40));

    const older = await stream(null, { recording: true });
    const given = await streams.update(older.id, { ...form(older, stageA), owner: 'b'.repeat(40) }, EDITABLE_STATUSES);
    assert.equal(given?.stage_id, stageA);
    assert.equal(given?.owner, OWNER, 'a recording keeps the owner it was made under');
  });

  it('gives a recorded draft older than stages only a stage that signs as its owner', async () => {
    const older = await stream(null, { recording: true });

    assert.equal(await streams.update(older.id, form(older, stageB), EDITABLE_STATUSES), null);
    assert.equal((await streams.findById(older.id))?.stage_id, null);
    // Stage A prints the same address in upper case and with 0x.
    assert.equal((await streams.update(older.id, form(older, stageA), EDITABLE_STATUSES))?.stage_id, stageA);
  });

  it('gives a draft with no recording its stage’s owner at the claim, as the stage signs now', async () => {
    const stages = new StageRepository(database.pool);
    const rotating = randomUUID();
    await stages.upsert(splitStageRecord(stageRecord({ stageId: rotating, name: 'Stage D', owner: STAGE_B_OWNER })));
    const row = await stream(rotating);
    await stages.upsert(
      splitStageRecord(
        stageRecord({
          stageId: rotating,
          name: 'Stage D',
          owner: ROTATED_OWNER,
          observedAt: '2026-09-28T10:05:00.000Z',
        }),
      ),
    );

    const claimed = await streams.claimForPublish(row.id, ['draft', 'published'], true);

    assert.equal(claimed?.owner, ROTATED_OWNER.slice(2), 'lower case, without 0x');
  });

  it('refuses the publish claim of a recorded draft whose stage signs as another owner', async () => {
    const recorded = await stream(stageB, { recording: true });

    assert.equal(await streams.claimForPublish(recorded.id, ['draft', 'published'], true), null);
    assert.equal((await streams.findById(recorded.id))?.status, 'draft', 'not claimed');
    // An unpublish claim does not ask.
    assert.equal((await streams.claimForPublish(recorded.id, ['draft', 'published', 'vod']))?.status, 'publishing');
  });

  it('leaves the owner alone at an unpublish claim, which removes an entry by the owner it was written with', async () => {
    const row = await stream(stageB);

    assert.equal((await streams.claimForPublish(row.id, ['draft', 'published', 'vod']))?.owner, OWNER);
  });

  it('keeps the owner of a recorded draft and of a published stream at the claim', async () => {
    // Stage A prints OWNER in upper case and with 0x, which is still that owner.
    const recorded = await stream(stageA, { recording: true });
    assert.equal((await streams.claimForPublish(recorded.id, ['draft'], true))?.owner, OWNER);

    const published = await stream(stageB, { status: 'published' });
    assert.equal((await streams.claimForPublish(published.id, ['published'], true))?.owner, OWNER);
  });

  it('lists every stage’s owner once, retired ones included', async () => {
    const stages = new StageRepository(database.pool);
    const retired = randomUUID();
    const twin = randomUUID();
    const retiredAlone = randomUUID();
    // No other stage signs as this one, so only a list that takes retired stages has it.
    const retiredOwner = '0x5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3d2e1';
    await stages.upsert(splitStageRecord(stageRecord({ stageId: retired, name: 'Stage E', owner: ROTATED_OWNER })));
    await stages.upsert(splitStageRecord(stageRecord({ stageId: twin, name: 'Stage F', owner: ROTATED_OWNER })));
    await stages.upsert(splitStageRecord(stageRecord({ stageId: retiredAlone, name: 'Stage G', owner: retiredOwner })));
    assert.equal((await stages.retire(retired, '2099-01-01T00:00:00.000Z')).outcome, 'done');
    assert.equal((await stages.retire(retiredAlone, '2099-01-01T00:00:00.000Z')).outcome, 'done');

    const owners = await stages.listOwners();

    assert.equal(owners.filter((owner) => owner === ROTATED_OWNER).length, 1);
    assert.ok(owners.includes(retiredOwner), 'the owner only a retired stage has is listed');
    assert.ok(owners.includes(STAGE_B_OWNER));
    // The fixture is pushed without the schema's parse, so it keeps its case.
    assert.ok(owners.includes(STAGE_A_OWNER));
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
