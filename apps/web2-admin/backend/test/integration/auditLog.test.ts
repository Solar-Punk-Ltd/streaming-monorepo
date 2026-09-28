/**
 * PostgresAuditLog against the real database (migration 007). Needs Postgres,
 * like the rest of this suite; `DATABASE_URL` overrides the connection.
 *
 * What a fake cannot stand in for is the schema: that the row the adapter
 * writes reads back column for column, that `stream_id` takes the id of a
 * stream that no longer exists (there is deliberately no foreign key), and
 * that removing the acting user keeps the row and its username while the id
 * goes null.
 *
 * It creates its own users and removes them in `after`; the audit rows it
 * writes are found by a topic of its own and deleted first.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { Database } from '../../src/domain/Database.js';
import { PostgresAuditLog } from '../../src/domain/PostgresAuditLog.js';

import { releaseStack, requireStack, stack } from './helpers.js';

interface AuditRow {
  id: string;
  at: Date;
  actor_kind: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  stream_id: string | null;
  topic: string | null;
  status_before: string | null;
  status_after: string | null;
  details: Record<string, unknown> | null;
}

let database: Database;
let audit: PostgresAuditLog;
const createdUsers: string[] = [];
const topics: string[] = [];

async function newUser(): Promise<{ id: string; username: string }> {
  const result = await database.pool.query<{ id: string; username: string }>(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, 'scrypt$16384$8$1$aaaa$bbbb')
     RETURNING id, username`,
    [`itest-${randomUUID().slice(0, 8)}`],
  );
  createdUsers.push(result.rows[0]!.id);
  return result.rows[0]!;
}

/** A topic no other test writes, so its rows can be read back and cleaned up. */
function newTopic(): string {
  const topic = randomUUID();
  topics.push(topic);
  return topic;
}

async function rowsFor(topic: string): Promise<AuditRow[]> {
  const result = await database.pool.query<AuditRow>('SELECT * FROM audit_log WHERE topic = $1 ORDER BY id', [topic]);
  return result.rows;
}

before(async () => {
  await requireStack();
  database = new Database(stack().databaseUrl);
  audit = new PostgresAuditLog(database.pool);
});

after(async () => {
  // `before` may have failed before the pool existed; the stack still has to
  // be released.
  if (!database) {
    await releaseStack();
    return;
  }
  if (topics.length > 0) {
    await database.pool.query('DELETE FROM audit_log WHERE topic = ANY($1::text[])', [topics]);
  }
  if (createdUsers.length > 0) {
    await database.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]);
  }
  await database.close();
  await releaseStack();
});

describe('PostgresAuditLog', () => {
  it('writes an operator entry that reads back column for column', async () => {
    const user = await newUser();
    const topic = newTopic();
    const streamId = randomUUID();

    await audit.record({
      actor: { kind: 'operator', userId: user.id, username: user.username },
      action: 'stream.publish',
      streamId,
      topic,
      statusBefore: 'draft',
      statusAfter: 'published',
      details: { feedIndex: 12, entryCount: 3 },
    });

    const [row, ...rest] = await rowsFor(topic);
    assert.equal(rest.length, 0);
    assert.ok(row);
    assert.ok(row.at instanceof Date);
    assert.equal(row.actor_kind, 'operator');
    assert.equal(row.actor_user_id, user.id);
    assert.equal(row.actor_name, user.username);
    assert.equal(row.action, 'stream.publish');
    assert.equal(row.stream_id, streamId, 'no stream row exists: there is no foreign key to refuse it');
    assert.equal(row.status_before, 'draft');
    assert.equal(row.status_after, 'published');
    assert.deepEqual(row.details, { feedIndex: 12, entryCount: 3 });
  });

  it('writes the uploader with no name, and the system with its reason', async () => {
    const topic = newTopic();

    await audit.record({ actor: { kind: 'uploader' }, action: 'stream.state.live', topic });
    await audit.record({ actor: { kind: 'system', reason: 'boot' }, action: 'stream.publishing.reset', topic });

    const rows = await rowsFor(topic);
    assert.deepEqual(
      rows.map((row) => [row.actor_kind, row.actor_user_id, row.actor_name, row.details]),
      [
        ['uploader', null, null, null],
        ['system', null, 'boot', null],
      ],
    );
  });

  it('keeps the row and the username when the acting user is removed', async () => {
    const user = await newUser();
    const topic = newTopic();
    await audit.record({
      actor: { kind: 'operator', userId: user.id, username: user.username },
      action: 'stream.delete',
      streamId: randomUUID(),
      topic,
      statusBefore: 'draft',
      statusAfter: null,
    });

    await database.pool.query('DELETE FROM users WHERE id = $1', [user.id]);

    const [row] = await rowsFor(topic);
    assert.ok(row, 'the row outlives the user');
    assert.equal(row.actor_user_id, null, 'ON DELETE SET NULL');
    assert.equal(row.actor_name, user.username, 'and the name it was done under is still there');
  });

  it('refuses details that are not an object', async () => {
    await assert.rejects(
      database.pool.query(
        `INSERT INTO audit_log (actor_kind, action, topic, details) VALUES ('uploader', 'stream.state.live', $1, '[1]'::jsonb)`,
        [newTopic()],
      ),
      { code: '23514' },
      'check_violation',
    );
  });
});
