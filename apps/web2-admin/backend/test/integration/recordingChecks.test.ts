/**
 * The checks of the recordings in Postgres: RecordingCheckRepository over migration 031, and the mark a finished check
 * leaves on a stream's row, which a `live` report takes off. Integration test: `pnpm test:integration`.
 *
 * Pinned here: one check runs at a time; a check lists its streams and keeps each one's readings; it finishes only
 * while it runs, with a verdict per stream, and marks the streams judged lost or partly lost and unmarks one that
 * read; a removal is recorded once, and only of a recording judged lost; a check stops with its reason, and the boot
 * stops every check left running.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { RecordingCheckRepository } from '../../src/domain/recordings/RecordingCheckRepository.js';
import { StreamRepository } from '../../src/domain/StreamRepository.js';
import { newPublishKey } from '../../src/domain/StreamService.js';
import type { StreamRow } from '../../src/types/index.js';

import { releaseStack, requireStack, stack } from './helpers.js';

let database: Database;
let checks: RecordingCheckRepository;
let streams: StreamRepository;
let userId: string;

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  checks = new RecordingCheckRepository(database.pool);
  streams = new StreamRepository(database.pool);
  const user = await database.pool.query<{ id: string }>(
    `INSERT INTO users (username, password_hash) VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb') RETURNING id`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  userId = user.rows[0]!.id;
});

after(async () => {
  if (!database) {
    await releaseStack();
    return;
  }
  await database.pool.query('DELETE FROM recording_checks');
  await database.pool.query('DELETE FROM streams WHERE user_id = $1', [userId]);
  await database.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await database.close();
  await releaseStack();
});

beforeEach(async () => {
  await database.pool.query('DELETE FROM recording_checks');
});

function stream(title: string): Promise<StreamRow> {
  return streams.insert({
    user_id: userId,
    topic: randomUUID(),
    owner: '90f8bf6a479f320ead074411a4b0e7944ea8c9c1',
    title,
    description: 'a stream whose recording a check reads',
    tags: [],
    media_type: 'video',
    scheduled_start_time: null,
    publish_key: newPublishKey(),
    stage_id: null,
  });
}

function listed(...rows: StreamRow[]) {
  return rows.map((row) => ({ streamId: row.id, title: row.title, status: row.status }));
}

function start(rows: StreamRow[], unjudged = 0) {
  return checks.create({
    id: randomUUID(),
    startedBy: 'itest',
    startedByUserId: userId,
    unjudged,
    streams: listed(...rows),
  });
}

async function marks(rows: StreamRow[]): Promise<Map<string, [string | null, boolean]>> {
  const result = await database.pool.query<{ id: string; recording_verdict: string | null; checked: boolean }>(
    `SELECT id::text AS id, recording_verdict, recording_checked_at IS NOT NULL AS checked
       FROM streams WHERE id = ANY($1::uuid[])`,
    [rows.map((row) => row.id)],
  );
  return new Map(result.rows.map((row) => [row.id, [row.recording_verdict, row.checked]]));
}

describe('recording_checks', () => {
  it('runs one check at a time, lists its streams by title, and keeps each one’s readings and round', async () => {
    const beta = await stream('Beta');
    const alpha = await stream('Alpha');
    const first = await start([beta, alpha], 2);
    assert.equal(first?.state, 'running');
    assert.equal(first?.round, 1);
    assert.equal(first?.unjudged, 2);
    assert.equal(await start([]), null, 'one check runs at a time');

    const readings = { master: [true], qualities: [{ name: 'source', rounds: [true] }] };
    await checks.recordReadings(first!.id, alpha.id, readings);
    assert.deepEqual(
      (await checks.streams(first!.id)).map((row) => [row.title, row.readings, row.verdict, row.removal]),
      [
        ['Alpha', readings, null, null],
        ['Beta', { master: [], qualities: [] }, null, null],
      ],
    );
    const next = new Date(Date.now() + 600_000);
    const waiting = await checks.recordRound(first!.id, 2, next);
    assert.equal(waiting?.round, 2);
    assert.equal(waiting?.nextRoundAt?.getTime(), next.getTime());
    assert.equal((await checks.latest())?.id, first!.id);
  });

  it('finishes with a verdict per stream, marks the lost and partly lost, unmarks one that read, and live unmarks', async () => {
    const lost = await stream('Lost');
    const partly = await stream('Partly');
    const fine = await stream('Fine');
    const left = await stream('Left');
    await database.pool.query(
      `UPDATE streams SET recording_verdict = 'lost', recording_checked_at = NOW() WHERE id = $1`,
      [fine.id],
    );
    const check = await start([lost, partly, fine, left]);

    const done = await checks.finish(
      check!.id,
      [
        { streamId: lost.id, verdict: 'lost', hasExportFile: true },
        { streamId: partly.id, verdict: 'partly_lost', hasExportFile: false },
        { streamId: fine.id, verdict: 'readable', hasExportFile: false },
        { streamId: left.id, verdict: null, hasExportFile: false },
      ],
      3,
    );
    assert.equal(done?.state, 'done');
    assert.equal(done?.unjudged, 3);
    assert.notEqual(done?.finishedAt ?? null, null);
    assert.equal(await checks.finish(check!.id, [], 0), null, 'only a running check finishes');

    assert.deepEqual(
      (await checks.streams(check!.id)).map((row) => [row.title, row.verdict, row.hasExportFile]),
      [
        ['Fine', 'readable', false],
        ['Left', null, false],
        ['Lost', 'lost', true],
        ['Partly', 'partly_lost', false],
      ],
    );
    const marked = await marks([lost, partly, fine, left]);
    assert.deepEqual(marked.get(lost.id), ['lost', true]);
    assert.deepEqual(marked.get(partly.id), ['partly_lost', true]);
    assert.deepEqual(marked.get(fine.id), [null, false], 'a recording that read loses its mark');
    assert.deepEqual(marked.get(left.id), [null, false], 'an unjudged one is left as it was');

    await streams.markLive(lost.id, ['draft']);
    assert.deepEqual((await marks([lost])).get(lost.id), [null, false], 'going live takes the mark off');
    await checks.clearVerdict(partly.id);
    assert.deepEqual((await marks([partly])).get(partly.id), [null, false]);
  });

  it('records a removal once, a kept one with its reason, and only of a recording judged lost', async () => {
    const lost = await stream('Lost');
    const fine = await stream('Fine');
    const check = await start([lost, fine]);
    await checks.finish(
      check!.id,
      [
        { streamId: lost.id, verdict: 'lost', hasExportFile: false },
        { streamId: fine.id, verdict: 'readable', hasExportFile: false },
      ],
      0,
    );

    await checks.recordRemoval(check!.id, lost.id, 'kept', 'It is live now.');
    await checks.recordRemoval(check!.id, lost.id, 'removed', null);
    const row = (await checks.streams(check!.id)).find((one) => one.streamId === lost.id);
    assert.deepEqual([row?.removal, row?.keptReason], ['kept', 'It is live now.']);
    assert.notEqual(row?.removedAt ?? null, null);
    await assert.rejects(checks.recordRemoval(check!.id, fine.id, 'removed', null), /check constraint/);
  });

  it('lists each stream a removal kept as a draft for its export file once, with the latest such removal', async () => {
    const filed = await stream('Filed');
    const gone = await stream('Gone');
    const first = await start([filed, gone]);
    await checks.finish(
      first!.id,
      [
        { streamId: filed.id, verdict: 'lost', hasExportFile: true },
        { streamId: gone.id, verdict: 'lost', hasExportFile: false },
      ],
      0,
    );
    await checks.recordRemoval(first!.id, filed.id, 'unlisted', null);
    await checks.recordRemoval(first!.id, gone.id, 'removed', null);
    const second = await start([filed]);
    await checks.finish(second!.id, [{ streamId: filed.id, verdict: 'lost', hasExportFile: true }], 0);
    await checks.recordRemoval(second!.id, filed.id, 'unlisted', null);

    const listed = await checks.unlisted();
    assert.deepEqual(
      listed.map((one) => one.streamId),
      [filed.id],
    );
    const latest = (await checks.streams(second!.id))[0]?.removedAt;
    assert.equal(listed[0]?.removedAt.getTime(), latest?.getTime());
  });

  it('stops a running check with its reason, and at boot every check left running', async () => {
    const one = await start([]);
    const stopped = await checks.stop(one!.id, 'The catalogue node does not answer.');
    assert.equal(stopped?.state, 'stopped');
    assert.equal(stopped?.stopMessage, 'The catalogue node does not answer.');
    assert.notEqual(stopped?.finishedAt ?? null, null);
    assert.equal(await checks.stop(one!.id, 'again'), null);
    assert.equal(await checks.recordRound(one!.id, 2, null), null, 'a stopped check takes no round');

    const two = await start([]);
    const atBoot = await checks.stopRunning('The admin restarted while the check ran. Start a new check.');
    assert.deepEqual(
      atBoot.map((check) => check.id),
      [two!.id],
    );
    assert.equal((await checks.latest())?.state, 'stopped');
  });
});
